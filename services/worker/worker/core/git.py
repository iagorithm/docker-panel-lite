from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote


class GitError(Exception):
    pass


@dataclass
class GitResult:
    ok: bool
    message: str


def _inject_token(url: str, token: str) -> str:
    if token and url.startswith("https://"):
        return url.replace("https://", f"https://x-access-token:{quote(token, safe='')}@", 1)
    return url


def _sanitize_stderr(stderr: str, token: str) -> str:
    if token:
        return stderr.replace(token, "***").replace(quote(token, safe=""), "***")
    return stderr


def clone_repo(repo_url: str, dest: Path, token: str = "", timeout: int = 300, branch: str = "") -> GitResult:
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise GitError(f"Could not create clone directory '{dest.parent}': {error}") from error

    command = ["git", "clone"]
    if branch:
        command.extend(["--branch", branch])
    command.extend([_inject_token(repo_url, token), str(dest)])

    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise GitError("Timed out while cloning the repository") from error
    except Exception as error:
        raise GitError(f"Unexpected failure while cloning: {error}") from error

    if result.returncode != 0:
        raise GitError(_sanitize_stderr(result.stderr, token))
    return GitResult(ok=True, message="Repository cloned")


def pull_repo(repo_path: Path, token: str = "", timeout: int = 300, branch: str = "") -> GitResult:
    try:
        if branch:
            fetch_result = subprocess.run(
                ["git", "-C", str(repo_path), "fetch", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}"],
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
            switch_result = subprocess.run(switch_command, capture_output=True, text=True, timeout=timeout)
            if switch_result.returncode != 0:
                raise GitError(_sanitize_stderr(switch_result.stderr, token))

        result = subprocess.run(
            ["git", "-C", str(repo_path), "pull", "--ff-only"] + (["origin", branch] if branch else []),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise GitError("Timed out while updating the repository") from error
    except GitError:
        raise
    except Exception as error:
        raise GitError(f"Unexpected failure while updating: {error}") from error

    if result.returncode != 0:
        raise GitError(_sanitize_stderr(result.stderr, token))
    return GitResult(ok=True, message=f"Repository updated from branch '{branch}'" if branch else "Repository updated")


def list_remote_branches(repo_url: str, token: str = "", timeout: int = 30) -> list[str]:
    try:
        result = subprocess.run(
            ["git", "ls-remote", "--symref", _inject_token(repo_url, token), "HEAD", "refs/heads/*"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise GitError("Timed out while reading remote branches") from error
    except Exception as error:
        raise GitError(f"Unexpected failure while reading remote branches: {error}") from error

    if result.returncode != 0:
        raise GitError(_sanitize_stderr(result.stderr, token))

    default_branch = ""
    branches: set[str] = set()
    for line in result.stdout.splitlines():
        if line.startswith("ref: refs/heads/") and line.endswith("\tHEAD"):
            default_branch = line.removeprefix("ref: refs/heads/").removesuffix("\tHEAD")
            continue
        _, separator, ref = line.partition("\t")
        if separator and ref.startswith("refs/heads/"):
            branches.add(ref.removeprefix("refs/heads/"))

    ordered = sorted(branches, key=str.casefold)
    if default_branch in branches:
        ordered.remove(default_branch)
        ordered.insert(0, default_branch)
    return ordered


def sync_repo(repo_url: str, repo_path: Path, token: str = "", timeout: int = 300, branch: str = "") -> GitResult:
    if (repo_path / ".git").is_dir():
        return pull_repo(repo_path, token=token, timeout=timeout, branch=branch)

    if repo_path.exists():
        if not repo_path.is_dir():
            raise GitError(f"Clone destination '{repo_path}' exists and is not a directory")
        try:
            next(repo_path.iterdir())
        except StopIteration:
            pass
        except OSError as error:
            raise GitError(f"Could not inspect clone destination '{repo_path}': {error}") from error
        else:
            raise GitError(f"Clone destination '{repo_path}' exists and is not an empty Git repository")

    return clone_repo(repo_url, repo_path, token=token, timeout=timeout, branch=branch)
