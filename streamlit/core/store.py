"""Persistence layer (JSON on disk) with robust error handling.

Centralizes reading/writing of repositories, credentials and the admin
account. Any file corruption is handled safely so the user session is not
broken.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime
from pathlib import Path


class StoreError(Exception):
    """Read/write error from the persistence layer."""


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise StoreError(f"Could not read {path.name}: {e}") from e


def _write_json(path: Path, data) -> None:
    try:
        path.write_text(json.dumps(data, indent=2))
    except OSError as e:
        raise StoreError(f"Could not write {path.name}: {e}") from e


# --------------------------------------------------------------------------
# Repositories
# --------------------------------------------------------------------------
def load_repos(path: Path) -> dict:
    return _read_json(path, {})


def save_repos(path: Path, repos: dict) -> None:
    _write_json(path, repos)


# --------------------------------------------------------------------------
# GitHub credentials
# --------------------------------------------------------------------------
def load_credentials(path: Path) -> dict:
    return _read_json(path, {})


def save_credentials(path: Path, creds: dict) -> None:
    _write_json(path, creds)


# --------------------------------------------------------------------------
# Admin (auth)
# --------------------------------------------------------------------------
def admin_exists(path: Path) -> bool:
    return path.exists()


def load_admin(path: Path) -> dict:
    return _read_json(path, {})


def save_admin(path: Path, username: str, password: str) -> None:
    salt = secrets.token_hex(16)
    admin = {
        "username": username,
        "salt": salt,
        "hash": _hash_password(password, salt),
        "created_at": datetime.now().isoformat(),
    }
    _write_json(path, admin)


def verify_login(path: Path, username: str, password: str) -> bool:
    admin = load_admin(path)
    if not admin:
        return False
    return username == admin.get("username") and _hash_password(password, admin.get("salt", "")) == admin.get("hash")


def _hash_password(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode()).hexdigest()
