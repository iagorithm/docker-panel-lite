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


def clone_repo(repo_url: str, dest: Path, token: str = "", timeout: int = 300) -> GitResult:
    """Clone a repository for the first time.

    Returns GitResult(ok, message). Raises GitError on failure.
    """
    clone_url = _inject_token(repo_url, token)
    try:
        result = subprocess.run(
            ["git", "clone", clone_url, str(dest)],
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


def pull_repo(repo_path: Path, token: str = "", timeout: int = 300) -> GitResult:
    """Update an already-cloned repository (git pull)."""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_path), "pull"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise GitError("Timed out while updating the repository") from e
    except Exception as e:  # noqa: BLE001
        raise GitError(f"Unexpected failure while updating: {e}") from e

    if result.returncode != 0:
        raise GitError(result.stderr)
    return GitResult(ok=True, message="Repository updated")


def sync_repo(repo_url: str, repo_path: Path, token: str = "", timeout: int = 300) -> GitResult:
    """Clone if it does not exist yet, otherwise pull the existing clone."""
    if repo_path.exists():
        return pull_repo(repo_path, token=token, timeout=timeout)
    return clone_repo(repo_url, repo_path, token=token, timeout=timeout)
