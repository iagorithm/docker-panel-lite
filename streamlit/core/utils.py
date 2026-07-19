"""Shared utilities: port/env parsing, token masking and validation."""

from __future__ import annotations

import re
from pathlib import PurePosixPath


def parse_ports(port_str: str) -> dict:
    """'8080:80,9000:9000' -> {'80/tcp': 8080, '9000/tcp': 9000}"""
    ports: dict = {}
    for pair in (port_str or "").split(","):
        pair = pair.strip()
        if ":" in pair:
            host, cont = pair.split(":", 1)
            try:
                ports[f"{cont.strip()}/tcp"] = int(host.strip())
            except ValueError:
                pass
    return ports


def parse_env(env_str: str) -> list[str]:
    """'KEY=VALUE\nFOO=bar' -> ['KEY=VALUE', 'FOO=bar'].

    Ignores empty/comment lines, drops duplicates and keeps the first
    non-empty value.
    """
    seen: dict[str, str] = {}
    for line in (env_str or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not key:
            continue
        if key not in seen or (seen[key] == "" and value != ""):
            seen[key] = value
    return [f"{k}={v}" for k, v in seen.items()]


def mask_token(token: str) -> str:
    if not token:
        return "—"
    return f"{token[:4]}{'•' * 8}{token[-4:]}" if len(token) > 8 else "••••••••"


_ALIAS_RE = re.compile(r"[^A-Za-z0-9_-]")


def sanitize_alias(value: str) -> str:
    """Keep only alphanumeric, dash and underscore characters (replace spaces)."""
    return "".join(c for c in value.strip().replace(" ", "_") if c.isalnum() or c in "_-")


def is_safe_alias(value: str) -> bool:
    """True if the alias contains at least one alphanumeric character."""
    return bool(re.search(r"[A-Za-z0-9]", value or ""))


def validate_repo_url(url: str) -> bool:
    """Accept the usual git URLs: https:// and ssh (git@...)."""
    if not url:
        return False
    return url.startswith("https://") or url.startswith("git@") or url.startswith("ssh://")


def validate_branch_name(value: str) -> bool:
    """Validate the common Git branch-name constraints without invoking a shell."""
    branch = (value or "").strip()
    if not branch:
        return True
    if branch in {"@", "HEAD"} or branch.startswith(("-", ".", "/")):
        return False
    if branch.endswith((".", "/", ".lock")):
        return False
    if any(part.startswith(".") or part.endswith(".lock") for part in branch.split("/")):
        return False
    forbidden = ("..", "@{", "//", "\\", " ", "~", "^", ":", "?", "*", "[")
    return not any(item in branch for item in forbidden) and all(ord(char) >= 32 for char in branch)


def validate_relative_file_path(value: str) -> bool:
    """Validate a repository-relative file path without parent traversal."""
    candidate = (value or "").strip()
    if not candidate or candidate.endswith("/") or candidate.startswith("~"):
        return False
    if "\x00" in candidate or "\\" in candidate:
        return False

    path = PurePosixPath(candidate)
    return not path.is_absolute() and ".." not in path.parts and bool(path.name)
