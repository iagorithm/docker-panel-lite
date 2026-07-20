#!/usr/bin/env python3
"""Import the legacy Streamlit JSON stores into Firebase RTDB.

Dry-run is the default. Tokens are encrypted locally before any write and are
never printed.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker.firebase_runtime import initialize, reference  # noqa: E402


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def environment(value: object) -> dict[str, str]:
    if isinstance(value, dict):
        return {str(key): str(item) for key, item in value.items()}
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return {str(key): str(item) for key, item in parsed.items()}
    except json.JSONDecodeError:
        pass
    result = {}
    for line in value.splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, item = line.split("=", 1)
            result[key.strip()] = item.strip()
    return result


def encrypt(token: str, encoded_key: str) -> dict:
    key = base64.b64decode(encoded_key, validate=True)
    if len(key) != 32:
        raise ValueError("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes")
    iv = os.urandom(12)
    encrypted = AESGCM(key).encrypt(iv, token.encode(), None)
    return {"algorithm": "aes-256-gcm", "version": 1, "iv": base64.b64encode(iv).decode(), "ciphertext": base64.b64encode(encrypted[:-16]).decode(), "tag": base64.b64encode(encrypted[-16:]).decode()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("streamlit/data"))
    parser.add_argument("--workspace", default=os.getenv("WORKER_WORKSPACE_ID", "default"))
    parser.add_argument("--apply", action="store_true", help="Write the generated records to Firebase")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite records that already exist")
    args = parser.parse_args()
    repos = read_json(args.data_dir / "repos.json")
    credentials = read_json(args.data_dir / "github_credentials.json")
    now = int(time.time() * 1000)
    updates: dict[str, object] = {}
    for repository_id, legacy in repos.items():
        env = environment(legacy.get("env_vars") or legacy.get("env"))
        updates[f"workspaces/{args.workspace}/repositories/{repository_id}"] = {
            "id": repository_id, "alias": repository_id, "url": legacy.get("url", ""), "branch": legacy.get("branch", ""),
            "mode": legacy.get("mode", "compose"), "composeFile": legacy.get("compose_file", "docker-compose.yml"),
            "dockerfile": legacy.get("dockerfile", "Dockerfile"), "credentialId": legacy.get("credential", ""),
            "environment": env, "domain": legacy.get("domain", ""), "service": legacy.get("service", "web"),
            "internalPort": int(legacy.get("internal_port", 3000)), "poolId": "default", "createdAt": now, "updatedAt": now,
            "ports": legacy.get("ports", ""),
        }
    key = os.getenv("CREDENTIAL_ENCRYPTION_KEY", "")
    for credential_id, legacy in credentials.items():
        token = str(legacy.get("token", ""))
        if token and not key:
            raise ValueError("CREDENTIAL_ENCRYPTION_KEY is required to migrate credentials")
        if token:
            updates[f"secrets/credentials/{args.workspace}/{credential_id}"] = {**encrypt(token, key), "username": legacy.get("username", ""), "updatedAt": now}
        updates[f"workspaces/{args.workspace}/credentials/{credential_id}"] = {"id": credential_id, "alias": credential_id, "username": legacy.get("username", ""), "tokenMask": "••••••••", "updatedAt": now}
    print(f"Prepared {len(repos)} repositories and {len(credentials)} credentials for workspace '{args.workspace}'.")
    if not args.apply:
        print("Dry run only. Add --apply to write to Firebase.")
        return
    initialize(os.environ["FIREBASE_DATABASE_URL"], os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", ""))
    if not args.overwrite:
        updates = {path: value for path, value in updates.items() if not reference(path).get()}
    reference().update(updates)
    print(f"Migrated {len(updates)} records. No token values were printed.")


if __name__ == "__main__":
    main()
