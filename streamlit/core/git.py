"""Reusable git operations (clone/pull) isolated from the UI.

All interaction with the git CLI lives here so the presentation layer
(Streamlit) only renders widgets and captures events.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitError(Exception):
    """Git operation error with stderr already sanitized (no tokens leaked)."""


@dataclass
class GitResult:
    ok: bool
    message: str


def _inject_token(url: str, token: str) -> str:
    """Insert the token into an https:// URL without breaking it."""
    if token and url.startswith("https://"):
        return url.replace("https://", f"https://{token}@", 1)
    return url


def _sanitize_stderr(stderr: str, token: str) -> str:
    """Prevent the token from appearing in error messages."""
    if token:
        return stderr.replace(token, "***")
    return stderr


def clone_repo(
    repo_url: str,
    dest: Path,
    token: str = "",
    timeout: int = 300,
    branch: str = "",
) -> GitResult:
    """Clone a repository for the first time.

    Returns GitResult(ok, message). Raises GitError on failure.
    """
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise GitError(f"Could not create clone directory '{dest.parent}': {e}") from e

    clone_url = _inject_token(repo_url, token)
    command = ["git", "clone"]
    if branch:
        command.extend(["--branch", branch])
    command.extend([clone_url, str(dest)])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise GitError("Timed out while cloning the repository") from e
    except Exception as e:  # noqa: BLE001 - generic surface for the UI
        raise GitError(f"Unexpected failure while cloning: {e}") from e

    if result.returncode != 0:
        raise GitError(_sanitize_stderr(result.stderr, token))
    return GitResult(ok=True, message="Repository cloned")


def pull_repo(
    repo_path: Path,
    token: str = "",
    timeout: int = 300,
    branch: str = "",
) -> GitResult:
    """Update an already-cloned repository (git pull)."""
    try:
        if branch:
            fetch_result = subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo_path),
                    "fetch",
                    "origin",
                    f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            if fetch_result.returncode != 0:
                raise GitError(_sanitize_stderr(fetch_result.stderr, token))

            local_branch = subprocess.run(
                ["git", "-C", str(repo_path), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            switch_command = (
                ["git", "-C", str(repo_path), "switch", branch]
                if local_branch.returncode == 0
                else ["git", "-C", str(repo_path), "switch", "--track", "-c", branch, f"origin/{branch}"]
            )
            switch_result = subprocess.run(
                switch_command,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            if switch_result.returncode != 0:
                raise GitError(_sanitize_stderr(switch_result.stderr, token))

        result = subprocess.run(
            ["git", "-C", str(repo_path), "pull", "--ff-only"]
            + (["origin", branch] if branch else []),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise GitError("Timed out while updating the repository") from e
    except GitError:
        raise
    except Exception as e:  # noqa: BLE001
        raise GitError(f"Unexpected failure while updating: {e}") from e

    if result.returncode != 0:
        raise GitError(_sanitize_stderr(result.stderr, token))
    return GitResult(
        ok=True,
        message=f"Repository updated from branch '{branch}'" if branch else "Repository updated",
    )


def list_branches(repo_path: Path, timeout: int = 30) -> list[str]:
    """Return local and origin branch names for a cloned repository."""
    if not (repo_path / ".git").is_dir():
        return []
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(repo_path),
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes/origin",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise GitError("Timed out while reading repository branches") from e
    except Exception as e:  # noqa: BLE001
        raise GitError(f"Unexpected failure while reading branches: {e}") from e
    if result.returncode != 0:
        raise GitError(result.stderr)

    branches: set[str] = set()
    for raw_branch in result.stdout.splitlines():
        branch = raw_branch.strip()
        if not branch or branch == "origin/HEAD":
            continue
        branches.add(branch.removeprefix("origin/"))
    return sorted(branches, key=str.casefold)


def sync_repo(
    repo_url: str,
    repo_path: Path,
    token: str = "",
    timeout: int = 300,
    branch: str = "",
) -> GitResult:
    """Clone if it does not exist yet, otherwise pull the existing clone."""
    if (repo_path / ".git").is_dir():
        return pull_repo(repo_path, token=token, timeout=timeout, branch=branch)

    if repo_path.exists():
        if not repo_path.is_dir():
            raise GitError(f"Clone destination '{repo_path}' exists and is not a directory")
        try:
            next(repo_path.iterdir())
        except StopIteration:
            pass
        except OSError as e:
            raise GitError(f"Could not inspect clone destination '{repo_path}': {e}") from e
        else:
            raise GitError(f"Clone destination '{repo_path}' exists and is not an empty Git repository")

    return clone_repo(repo_url, repo_path, token=token, timeout=timeout, branch=branch)
