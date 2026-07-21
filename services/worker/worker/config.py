from __future__ import annotations

import os
import hashlib
import re
import socket
import subprocess
import uuid
import json
from dataclasses import dataclass
from pathlib import Path


def _unquote_env_value(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    quote = value[0]
    if quote in {'"', "'"} and value.endswith(quote):
        inner = value[1:-1]
        return inner.replace("\\n", "\n").replace('\\"', '"') if quote == '"' else inner
    return value


def _load_environment_file() -> None:
    path = os.getenv("WORKER_CONFIG_FILE", "/app/config/worker.env").strip()
    if not path:
        return
    config_path = Path(path)
    if not config_path.is_file():
        return
    try:
        lines = config_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        if not os.getenv(key):
            os.environ[key] = _unquote_env_value(value)


def _integer(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _boolean(name: str, default: bool = False) -> bool:
    value = os.getenv(name, "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on", "enabled"}


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


def _safe_worker_part(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip()).strip("-").lower()
    return normalized or "default"


def _docker_host_fingerprint() -> tuple[str, str]:
    configured = _first_env("WORKER_MACHINE_ID", "HOST_MACHINE_ID")
    if configured:
        return configured, "env"
    try:
        completed = subprocess.run(
            ["docker", "info", "--format", "{{.ID}}|{{.Name}}"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
        value = completed.stdout.strip()
        if value and value != "|":
            return value, "docker"
    except Exception:
        pass
    machine_id = Path("/etc/machine-id")
    try:
        if machine_id.is_file():
            value = machine_id.read_text(encoding="utf-8").strip()
            if value:
                return value, "machine-id"
    except OSError:
        pass
    return "", ""


def _generated_worker_id(pool_id: str, fingerprint: str) -> str:
    digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:12]
    return f"worker-{_safe_worker_part(pool_id)}-{digest}"


def _worker_id(hostname: str, data_dir: Path, pool_id: str) -> tuple[str, str]:
    configured = os.getenv("WORKER_ID", "").strip()
    if configured:
        return configured, "env"
    fingerprint, source = _docker_host_fingerprint()
    if fingerprint:
        generated = _generated_worker_id(pool_id, fingerprint)
        try:
            data_dir.mkdir(parents=True, exist_ok=True)
            (data_dir / "worker-id").write_text(generated + "\n", encoding="utf-8")
        except OSError:
            pass
        return generated, source
    marker = data_dir / "worker-id"
    try:
        if marker.is_file():
            saved = marker.read_text(encoding="utf-8").strip()
            if saved:
                return saved, "marker"
        data_dir.mkdir(parents=True, exist_ok=True)
        generated = f"{hostname}-{uuid.uuid4().hex[:8]}"
        marker.write_text(generated + "\n", encoding="utf-8")
        return generated, "marker"
    except OSError:
        return f"{hostname}-{uuid.uuid4().hex[:8]}", "fallback"


@dataclass(frozen=True)
class Settings:
    firebase_database_url: str
    service_account_json: str
    workspace_id: str
    pool_id: str
    worker_id: str
    worker_identity_source: str
    worker_label: str
    worker_location: str
    hostname: str
    shards: tuple[str, ...]
    max_concurrency: int
    lease_seconds: int
    poll_seconds: int
    clone_dir: Path
    data_dir: Path
    encryption_key: str
    ngrok_enabled: bool
    ngrok_authtoken: str
    ngrok_bin: str
    ngrok_region: str

    @classmethod
    def from_environment(cls) -> "Settings":
        _load_environment_file()
        shard_count = _integer("QUEUE_SHARDS", 16)
        configured = tuple(filter(None, (item.strip() for item in os.getenv("WORKER_SHARDS", "").split(","))))
        service_account_json = _service_account_json()
        hostname = socket.gethostname()
        data_dir = Path(os.getenv("APP_DATA_DIR", "/app/data")).resolve()
        pool_id = os.getenv("WORKER_POOL", "default")
        worker_id, worker_identity_source = _worker_id(hostname, data_dir, pool_id)
        ngrok_authtoken = os.getenv("NGROK_AUTHTOKEN", "").strip()
        return cls(
            firebase_database_url=_firebase_database_url(service_account_json),
            service_account_json=service_account_json,
            workspace_id=os.getenv("WORKER_WORKSPACE_ID", "default"),
            pool_id=pool_id,
            worker_id=worker_id,
            worker_identity_source=worker_identity_source,
            worker_label=os.getenv("WORKER_LABEL", "").strip(),
            worker_location=os.getenv("WORKER_LOCATION", "").strip(),
            hostname=hostname,
            shards=configured or tuple(f"{item:02d}" for item in range(shard_count)),
            max_concurrency=_integer("WORKER_MAX_CONCURRENCY", 2),
            lease_seconds=_integer("WORKER_LEASE_SECONDS", 90, 30),
            poll_seconds=_integer("WORKER_POLL_SECONDS", 5),
            clone_dir=Path(os.getenv("APP_CLONE_DIR", "/app/clones")).resolve(),
            data_dir=data_dir,
            encryption_key=os.environ["CREDENTIAL_ENCRYPTION_KEY"],
            ngrok_enabled=_boolean("NGROK_ENABLED", bool(ngrok_authtoken)),
            ngrok_authtoken=ngrok_authtoken,
            ngrok_bin=os.getenv("NGROK_BIN", "ngrok"),
            ngrok_region=os.getenv("NGROK_REGION", "").strip(),
        )
