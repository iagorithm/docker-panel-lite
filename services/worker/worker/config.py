from __future__ import annotations

import os
import socket
import uuid
import json
from dataclasses import dataclass
from pathlib import Path


def _integer(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _first_env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _service_account_json() -> str:
    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw:
        return raw
    path = os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE") or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if path and Path(path).is_file():
        return Path(path).read_text(encoding="utf-8").strip()
    return ""


def _project_id(service_account_json: str) -> str:
    configured = _first_env("FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT")
    if configured:
        return configured
    if service_account_json:
        try:
            parsed = json.loads(service_account_json)
        except json.JSONDecodeError:
            return ""
        if isinstance(parsed, dict):
            return str(parsed.get("project_id") or "").strip()
    return ""


def _firebase_database_url(service_account_json: str) -> str:
    configured = _first_env("FIREBASE_DATABASE_URL", "NEXT_PUBLIC_FIREBASE_DATABASE_URL")
    if configured:
        return configured
    project_id = _project_id(service_account_json)
    if project_id:
        return f"https://{project_id}-default-rtdb.firebaseio.com"
    raise RuntimeError(
        "Configura FIREBASE_DATABASE_URL o NEXT_PUBLIC_FIREBASE_DATABASE_URL en .env "
        "(tambien puedes definir FIREBASE_PROJECT_ID para usar la URL default de Realtime Database)."
    )


@dataclass(frozen=True)
class Settings:
    firebase_database_url: str
    service_account_json: str
    workspace_id: str
    pool_id: str
    worker_id: str
    hostname: str
    shards: tuple[str, ...]
    max_concurrency: int
    lease_seconds: int
    poll_seconds: int
    clone_dir: Path
    data_dir: Path
    encryption_key: str
    traefik_network: str

    @classmethod
    def from_environment(cls) -> "Settings":
        shard_count = _integer("QUEUE_SHARDS", 16)
        configured = tuple(filter(None, (item.strip() for item in os.getenv("WORKER_SHARDS", "").split(","))))
        service_account_json = _service_account_json()
        return cls(
            firebase_database_url=_firebase_database_url(service_account_json),
            service_account_json=service_account_json,
            workspace_id=os.getenv("WORKER_WORKSPACE_ID", "default"),
            pool_id=os.getenv("WORKER_POOL", "default"),
            worker_id=os.getenv("WORKER_ID", f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"),
            hostname=socket.gethostname(),
            shards=configured or tuple(f"{item:02d}" for item in range(shard_count)),
            max_concurrency=_integer("WORKER_MAX_CONCURRENCY", 2),
            lease_seconds=_integer("WORKER_LEASE_SECONDS", 90, 30),
            poll_seconds=_integer("WORKER_POLL_SECONDS", 5),
            clone_dir=Path(os.getenv("APP_CLONE_DIR", "/app/clones")).resolve(),
            data_dir=Path(os.getenv("APP_DATA_DIR", "/app/data")).resolve(),
            encryption_key=os.environ["CREDENTIAL_ENCRYPTION_KEY"],
            traefik_network=os.getenv("TRAEFIK_NETWORK", "proxy"),
        )
