from __future__ import annotations

import os
import json
import logging
import re
import shlex
import socket
import subprocess
from pathlib import Path

import yaml
from docker.errors import NotFound

from worker.config import Settings
from worker.core import docker_ops, git, utils
from worker.firebase_runtime import reference
from worker.secrets import decrypt_secret

DEFAULT_COMPOSE_FILE = "compose.yml"
ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
LOG = logging.getLogger("deployment-worker")


def _safe_name(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-_").lower()
    if not cleaned:
        raise ValueError("Repository alias cannot produce an empty project name")
    return cleaned[:63]


def _repo_path(settings: Settings, repository: dict) -> Path:
    path = (settings.clone_dir / _safe_name(repository["alias"])).resolve()
    if settings.clone_dir != path and settings.clone_dir not in path.parents:
        raise ValueError("Repository path escapes the configured clone directory")
    return path


def _credential(workspace_id: str, credential_id: str, settings: Settings) -> str:
    if not credential_id:
        return ""
    encrypted = reference(f"secrets/credentials/{workspace_id}/{credential_id}").get()
    if not encrypted:
        raise ValueError(f"Credential '{credential_id}' does not exist")
    return decrypt_secret(encrypted, settings.encryption_key)


def _sync(repository: dict, workspace_id: str, settings: Settings) -> Path:
    path = _repo_path(settings, repository)
    token = _credential(workspace_id, repository.get("credentialId", ""), settings)
    git.sync_repo(repository["url"], path, token=token, branch=repository.get("branch", ""))
    return path


def _compact_json_text(value: str) -> str:
    text = value.strip()
    if not text or text[0] not in "{[":
        return value
    try:
        return json.dumps(json.loads(re.sub(r",\s*([}\]])", r"\1", text)), separators=(",", ":"))
    except json.JSONDecodeError:
        return value


def _normalize_environment_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return _compact_json_text(str(value)).replace("\x00", "")


def _parse_environment_text(value: str) -> dict[str, str]:
    raw = value.strip()
    if not raw:
        return {}
    if raw.startswith("{"):
        try:
            parsed = json.loads(re.sub(r",\s*([}\]])", r"\1", raw))
        except json.JSONDecodeError as error:
            raise ValueError("Environment JSON from Firebase is invalid") from error
        return _normalize_environment(parsed)
    result: dict[str, str] = {}
    current_key = ""
    for line in raw.splitlines():
        item = line.strip()
        if not item or item.startswith("#"):
            continue
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", line)
        if not match:
            if current_key:
                result[current_key] = f"{result[current_key]}\n{line}"
            continue
        key, env_value = match.group(1), match.group(2)
        value_text = env_value.strip()
        if len(value_text) >= 2 and value_text[0] == value_text[-1] and value_text[0] in {"'", '"'}:
            value_text = value_text[1:-1]
            if env_value.strip().startswith('"'):
                value_text = value_text.replace("\\n", "\n").replace('\\"', '"')
        else:
            value_text = re.sub(r"\s+#.*$", "", value_text).strip()
        current_key = key.strip()
        result[current_key] = value_text
    return {key: _normalize_environment_value(env_value) for key, env_value in result.items()}


def _normalize_environment(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if isinstance(value, str):
        return _parse_environment_text(value)
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            if isinstance(item, str):
                result.update(_parse_environment_text(item))
            elif isinstance(item, dict):
                key = str(item.get("key") or item.get("name") or "").strip()
                if key:
                    result[key] = _normalize_environment_value(item.get("value"))
        return result
    if isinstance(value, dict):
        result: dict[str, str] = {}
        for key, item in value.items():
            key_text = str(key).strip()
            if isinstance(item, dict) and ("value" in item or "Value" in item):
                item = item.get("value", item.get("Value"))
            result[key_text] = _normalize_environment_value(item)
        return result
    return {}


def _validate_environment(environment: dict[str, str]) -> dict[str, str]:
    return {key: value for key, value in environment.items() if ENV_KEY_PATTERN.match(key)}


def _load_environment(repository: dict, workspace_id: str) -> dict[str, str]:
    repository_id = repository.get("id") or repository.get("alias")
    environment = _normalize_environment(reference(f"workspaces/{workspace_id}/environment").get())

    # Legacy/imported records may still use env_vars or env in Firebase.
    if repository_id:
        environment.update(_normalize_environment(reference(f"workspaces/{workspace_id}/repositories/{repository_id}/env_vars").get()))
        environment.update(_normalize_environment(reference(f"workspaces/{workspace_id}/repositories/{repository_id}/env").get()))
    environment.update(_normalize_environment(repository.get("env_vars")))
    environment.update(_normalize_environment(repository.get("env")))
    environment.update(_normalize_environment(repository.get("environment")))

    if repository_id:
        firebase_environment = reference(f"workspaces/{workspace_id}/repositories/{repository_id}/environment").get()
        environment.update(_normalize_environment(firebase_environment))

    validated = _validate_environment(environment)
    if repository_id:
        LOG.info("Loaded %s environment vars for %s", len(validated), repository_id)
    return validated


def _compact_process_error(stderr: str, stdout: str = "") -> str:
    output = (stderr or stdout or "").strip()
    if not output:
        return "docker command failed"
    if "SIGSEGV" in output or "segmentation violation" in output:
        return (
            "docker compose crashed with SIGSEGV. Rebuild the worker image so Docker CLI/Compose "
            "match this machine architecture."
        )
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return "\n".join(lines[:12])[:2000]


def _command_output(stdout: str, stderr: str) -> str:
    parts = []
    if stdout.strip():
        parts.append(stdout.strip())
    if stderr.strip():
        parts.append(stderr.strip())
    return "\n\n".join(parts)[-120_000:]


def _decode_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return str(value)


def _non_interactive_command(command: str) -> list[str]:
    args = shlex.split(command)
    if not args:
        raise ValueError("Command is empty")
    executable = args[0]
    is_compose = executable == "docker-compose" or (len(args) > 1 and executable == "docker" and args[1] == "compose")
    if not is_compose or "exec" not in args:
        return args
    exec_index = args.index("exec")
    normalized = args[:exec_index + 1]
    if "-T" not in args[exec_index + 1:] and "--no-TTY" not in args[exec_index + 1:]:
        normalized.append("-T")
    for item in args[exec_index + 1:]:
        if item in {"-i", "-t", "-it", "-ti", "--interactive", "--tty"}:
            continue
        normalized.append(item)
    return normalized


def _container_exec_shell_command(command: str) -> str:
    args = shlex.split(command)
    if not args:
        raise ValueError("Command is empty")
    executable = args[0]
    is_compose = executable == "docker-compose" or (len(args) > 1 and executable == "docker" and args[1] == "compose")
    if not is_compose or "exec" not in args:
        return command
    index = args.index("exec") + 1
    options_with_value = {"-e", "--env", "-u", "--user", "-w", "--workdir", "--index"}
    while index < len(args):
        item = args[index]
        if item in {"-i", "-t", "-it", "-ti", "-T", "--interactive", "--tty", "--no-TTY", "--privileged"}:
            index += 1
            continue
        if item in options_with_value:
            index += 2
            continue
        if item.startswith("--env=") or item.startswith("--user=") or item.startswith("--workdir=") or item.startswith("--index="):
            index += 1
            continue
        if item.startswith("-"):
            index += 1
            continue
        break
    if index >= len(args) - 1:
        raise ValueError("Compose exec command must include a service and command")
    return shlex.join(args[index + 1:])


def _compose_service_names(compose_file: Path) -> list[str]:
    try:
        payload = yaml.safe_load(compose_file.read_text(encoding="utf-8")) or {}
    except Exception:
        return []
    services = payload.get("services") if isinstance(payload, dict) else None
    if not isinstance(services, dict):
        return []
    return [str(name) for name in services.keys() if str(name).strip()]


def _repository_file(
    path: Path,
    raw_value: str,
    default: str,
    label: str,
    *,
    must_exist: bool,
) -> Path:
    value = (raw_value or default).strip()
    if not utils.validate_relative_file_path(value):
        raise ValueError(f"{label} must be a file path relative to the repository root")
    resolved = (path / value).resolve()
    try:
        resolved.relative_to(path)
    except ValueError as error:
        raise ValueError(f"{label} resolves outside the repository") from error
    if must_exist and not resolved.is_file():
        raise FileNotFoundError(f"{label} not found: {value}")
    return resolved


def _compose_override(repository: dict, settings: Settings, environment: dict[str, str], compose_file: Path) -> Path | None:
    domain = repository.get("domain", "").strip() if settings.traefik_enabled else ""
    if not domain and not environment:
        return None
    project = _safe_name(repository["alias"])
    configured_service = repository.get("service", "web")
    service_names = _compose_service_names(compose_file) or [configured_service]
    traefik_service = configured_service if configured_service in service_names else service_names[0]
    override_dir = settings.data_dir / "overrides"
    override_dir.mkdir(parents=True, exist_ok=True)
    override = override_dir / f"{project}.traefik.yml"
    service_payloads: dict[str, dict[str, object]] = {}
    for service in service_names:
        service_payloads[service] = {"environment": environment} if environment else {}
    if domain:
        service_payloads.setdefault(traefik_service, {}).update({
            "labels": [
                "traefik.enable=true",
                f"traefik.http.routers.{project}.rule=Host(`{domain}`)",
                f"traefik.http.routers.{project}.entrypoints=websecure",
                f"traefik.http.routers.{project}.tls.certresolver=letsencrypt",
                f"traefik.http.services.{project}.loadbalancer.server.port={int(repository.get('internalPort', 3000))}",
            ],
            "networks": [settings.traefik_network],
        })
    payload: dict[str, object] = {"services": service_payloads}
    if domain:
        payload["networks"] = {settings.traefik_network: {"external": True}}
    override.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return override


def _run_compose(repository: dict, path: Path, settings: Settings, environment: dict[str, str], down: bool = False) -> str:
    project = _safe_name(repository["alias"])
    compose_file = _repository_file(
        path,
        repository.get("composeFile", ""),
        DEFAULT_COMPOSE_FILE,
        "Compose file",
        must_exist=True,
    )
    docker_ops.write_env_file(str(path), environment)
    command = ["docker", "compose", "-p", project, "-f", str(compose_file)]
    override = _compose_override(repository, settings, environment, compose_file)
    if override:
        command.extend(["-f", str(override)])
    command.extend(["down"] if down else ["up", "-d", "--build"])
    process = subprocess.run(
        command,
        cwd=path,
        capture_output=True,
        text=True,
        timeout=900,
        env=os.environ | environment,
    )
    if process.returncode:
        raise RuntimeError(_compact_process_error(process.stderr, process.stdout))
    return process.stdout.strip() or ("Stack stopped" if down else "Stack deployed")


def _run_dockerfile(repository: dict, path: Path, settings: Settings, environment: dict[str, str]) -> str:
    client = docker_ops.connect()
    project = _safe_name(repository["alias"])
    dockerfile = _repository_file(
        path,
        repository.get("dockerfile", ""),
        "Dockerfile",
        "Dockerfile",
        must_exist=True,
    )
    labels: dict[str, str] = {}
    network = None
    domain = repository.get("domain", "").strip() if settings.traefik_enabled else ""
    if domain:
        network = settings.traefik_network
        labels = {
            "traefik.enable": "true",
            f"traefik.http.routers.{project}.rule": f"Host(`{domain}`)",
            f"traefik.http.routers.{project}.entrypoints": "websecure",
            f"traefik.http.routers.{project}.tls.certresolver": "letsencrypt",
            f"traefik.http.services.{project}.loadbalancer.server.port": str(repository.get("internalPort", 3000)),
        }
    image, _ = client.images.build(
        path=str(path),
        dockerfile=str(dockerfile.relative_to(path)),
        tag=f"{project}:managed",
        rm=True,
    )
    try:
        client.containers.get(project).remove(force=True)
    except Exception as error:
        if error.__class__.__name__ != "NotFound":
            raise
    ports = utils.parse_ports(repository.get("ports", ""))
    container = client.containers.run(
        image.id,
        name=project,
        environment=environment or None,
        labels=labels,
        network=network,
        ports=ports or None,
        detach=True,
    )
    return f"Container {container.short_id} deployed"


def execute(job: dict, repository: dict, settings: Settings) -> tuple[str, dict]:
    action = job["action"]
    workspace_id = job["workspaceId"]
    mode = repository.get("mode")
    environment = _load_environment(repository, workspace_id)
    if action == "discover_branches":
        token = _credential(workspace_id, repository.get("credentialId", ""), settings)
        branches = git.list_remote_branches(repository["url"], token=token)
        return f"Found {len(branches)} branches", {"availableBranches": branches, "branchesUpdatedAt": _now()}
    if action == "stop":
        path = _repo_path(settings, repository)
        if mode == "compose":
            return _run_compose(repository, path, settings, environment, down=True), {}
        client = docker_ops.connect()
        client.containers.get(_safe_name(repository["alias"])).remove(force=True)
        return "Container stopped", {}
    path = _sync(repository, workspace_id, settings)
    if action in {"sync", "read_compose"}:
        updates = {}
        if mode == "compose":
            compose_path = _repository_file(
                path,
                repository.get("composeFile", ""),
                DEFAULT_COMPOSE_FILE,
                "Compose file",
                must_exist=True,
            )
            if compose_path.stat().st_size > 1_000_000:
                raise ValueError("Compose file is larger than 1 MB")
            updates["composeContent"] = compose_path.read_text(encoding="utf-8", errors="replace")
        return "Repository synchronized", updates
    if action not in {"deploy", "build"}:
        raise ValueError(f"Unknown repository action: {action}")
    if mode == "compose":
        return _run_compose(repository, path, settings, environment), {}
    return _run_dockerfile(repository, path, settings, environment), {}


def execute_worker_command(job: dict, repository: dict | None, settings: Settings) -> tuple[str, str, int]:
    command = str(job.get("command") or "").strip()
    if not command:
        raise ValueError("Command is empty")
    timeout = max(5, min(1800, int(job.get("timeoutSeconds") or 600)))
    environment: dict[str, str] = {}
    if repository:
        path = _repo_path(settings, repository)
        environment = _load_environment(repository, job["workspaceId"])
    else:
        path = settings.clone_dir.resolve()
    if not path.exists():
        raise FileNotFoundError(f"Working directory not found: {path}. Sync or deploy the repository first.")
    args = _non_interactive_command(command)
    LOG.info("Running worker command in %s: %s", path, " ".join(shlex.quote(item) for item in args[:8]))
    try:
        process = subprocess.run(
            args,
            cwd=path,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=os.environ | environment,
        )
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else (error.stderr or "")
        output = _command_output(stdout, stderr)
        return f"Command timed out after {timeout}s", output or f"Command timed out after {timeout}s", 124
    output = _command_output(process.stdout, process.stderr)
    if process.returncode:
        message = _compact_process_error(process.stderr, process.stdout)
        return f"Command exited with code {process.returncode}: {message}", output, process.returncode
    return "Command completed", output or "Command completed with no output.", 0


def execute_container_command(job: dict) -> tuple[str, str, int]:
    client = docker_ops.connect()
    last_error = None
    for candidate in _container_lookup_candidates(job):
        try:
            container = client.containers.get(candidate)
            break
        except NotFound as exc:
            last_error = exc
    else:
        raise last_error or ValueError("Container reference is missing")
    if _is_worker_container_object(container):
        raise ValueError("Worker containers can only be restarted or inspected with logs")
    command = str(job.get("command") or "").strip()
    if not command:
        raise ValueError("Command is empty")
    timeout = max(5, min(1800, int(job.get("timeoutSeconds") or 600)))
    shell_command = _container_exec_shell_command(command)
    LOG.info("Running command inside container %s: %s", container.name, shell_command[:160])
    socket_timeout = getattr(client.api, "timeout", None)
    try:
        client.api.timeout = timeout
        result = container.exec_run(["/bin/sh", "-lc", shell_command], stdout=True, stderr=True, stdin=False, tty=False, demux=True)
    finally:
        if socket_timeout is not None:
            client.api.timeout = socket_timeout
    output_value = result.output
    if isinstance(output_value, tuple):
        stdout, stderr = output_value
    else:
        stdout, stderr = output_value, b""
    output = _command_output(_decode_output(stdout), _decode_output(stderr))
    if result.exit_code:
        message = f"Container command exited with code {result.exit_code}"
        return message, output or message, int(result.exit_code)
    return f"Command completed inside '{container.name}'", output or "Command completed with no output.", 0


def _now() -> int:
    import time
    return int(time.time() * 1000)


def container_inventory() -> dict[str, dict]:
    client = docker_ops.connect()
    inventory = {}
    for container in client.containers.list(all=True):
        image_tags = container.image.tags if container.image else []
        ports = []
        for target, mappings in (container.attrs.get("NetworkSettings", {}).get("Ports", {}) or {}).items():
            for mapping in mappings or []:
                ports.append(f"{mapping.get('HostIp', '')}:{mapping.get('HostPort', '')}->{target}")
        inventory[container.id] = {
            "id": container.id, "name": container.name, "image": image_tags[0] if image_tags else container.image.short_id,
            "status": container.status, "project": container.labels.get("com.docker.compose.project", ""),
            "composeService": container.labels.get("com.docker.compose.service", ""),
            "ports": ports, "updatedAt": _now(),
        }
    return inventory


def _container_lookup_candidates(job: dict) -> list[str]:
    candidates = [job.get("containerRef"), job.get("containerId")]
    for value in list(candidates):
        if isinstance(value, str) and "--" in value:
            candidates.append(value.split("--", 1)[1])
    unique = []
    for value in candidates:
        if isinstance(value, str) and value and value not in unique:
            unique.append(value)
    return unique


def _is_worker_container_object(container) -> bool:
    hostname = socket.gethostname()
    name = container.name or ""
    labels = container.labels or {}
    normalized = _safe_name(name)
    if hostname and (container.id.startswith(hostname) or name == hostname):
        return True
    if labels.get("com.docker.compose.service") == "worker":
        return True
    return bool(re.search(r"(^|[-_])worker([-_]1)?$", normalized))


def execute_container(job: dict) -> tuple[str, str | None]:
    client = docker_ops.connect()
    last_error = None
    for candidate in _container_lookup_candidates(job):
        try:
            container = client.containers.get(candidate)
            break
        except NotFound as exc:
            last_error = exc
    else:
        raise last_error or ValueError("Container reference is missing")
    if _is_worker_container_object(container) and job["action"] in {"container_stop", "container_delete", "container_exec"}:
        raise ValueError("Worker containers can only be restarted or inspected with logs")
    if job["action"] == "container_start":
        container.start()
        return f"Container '{container.name}' started", None
    if job["action"] == "container_stop":
        container.stop(timeout=20)
        return f"Container '{container.name}' stopped", None
    if job["action"] == "container_restart":
        container.restart(timeout=20)
        return f"Container '{container.name}' restarted", None
    if job["action"] == "container_delete":
        name = container.name
        container.remove(force=True)
        return f"Container '{name}' deleted", None
    if job["action"] == "container_logs":
        return f"Loaded logs for '{container.name}'", container.logs(tail=100).decode(errors="replace")[-100_000:]
    if job["action"] == "container_exec":
        message, output, exit_code = execute_container_command(job)
        if exit_code:
            raise RuntimeError(message)
        return message, output
    raise ValueError(f"Unknown container action: {job['action']}")
