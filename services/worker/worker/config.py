from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass
from pathlib import Path


def _integer(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


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
        return cls(
            firebase_database_url=os.environ["FIREBASE_DATABASE_URL"],
            service_account_json=os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", ""),
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
