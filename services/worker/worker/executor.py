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
from worker.core import docker_ops, git, ngrok, utils
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


def _repository_public_tunnel_enabled(repository: dict) -> bool:
    return bool(
        repository.get("publicTunnelEnabled")
        or repository.get("exposePublic")
        or repository.get("ngrokEnabled")
    )


def _repository_public_tunnel_domain(repository: dict) -> str:
    return str(
        repository.get("publicTunnelDomain")
        or repository.get("publicDomain")
        or repository.get("ngrokDomain")
        or ""
    ).strip()


def _repository_public_tunnel_domains(repository: dict) -> dict[str, str]:
    value = repository.get("publicTunnelDomains") or repository.get("publicDomains") or repository.get("ngrokDomains") or {}
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{"):
            try:
                value = json.loads(re.sub(r",\s*([}\]])", r"\1", text))
            except json.JSONDecodeError:
                value = {}
        else:
            items = [item.strip() for item in re.split(r"[\n,]", text) if item.strip()]
            value = dict(item.split("=", 1) for item in items if "=" in item)
    if not isinstance(value, dict):
        return {}
    return {str(key).strip(): str(item).strip() for key, item in value.items() if str(key).strip() and str(item).strip()}


def _repository_public_tunnel_ports(repository: dict) -> dict[str, int]:
    value = repository.get("publicTunnelPorts") or repository.get("publicPorts") or repository.get("ngrokPorts") or {}
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{"):
            try:
                value = json.loads(re.sub(r",\s*([}\]])", r"\1", text))
            except json.JSONDecodeError:
                value = {}
        else:
            items = [item.strip() for item in re.split(r"[\n,]", text) if item.strip()]
            value = dict(item.split("=", 1) for item in items if "=" in item)
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, item in value.items():
        try:
            port = int(item)
        except (TypeError, ValueError):
            continue
        if 1 <= port <= 65535:
            result[str(key).strip()] = port
    return result


def _container_ip(container) -> str:
    networks = (container.attrs.get("NetworkSettings", {}) or {}).get("Networks", {}) or {}
    for network in networks.values():
        ip_address = str((network or {}).get("IPAddress") or "").strip()
        if ip_address:
            return ip_address
    return ""


def _container_internal_ports(container) -> list[int]:
    ports = []
    exposed = (container.attrs.get("Config", {}) or {}).get("ExposedPorts", {}) or {}
    published = (container.attrs.get("NetworkSettings", {}) or {}).get("Ports", {}) or {}
    for source in (exposed, published):
        for key in source.keys():
            try:
                port = int(str(key).split("/", 1)[0])
            except ValueError:
                continue
            if port not in ports:
                ports.append(port)
    return ports


def _connect_worker_to_container_networks(container) -> None:
    hostname = socket.gethostname()
    if not hostname:
        return
    try:
        client = docker_ops.connect()
        worker_container = client.containers.get(hostname)
    except Exception:
        return
    networks = (container.attrs.get("NetworkSettings", {}) or {}).get("Networks", {}) or {}
    worker_networks = (worker_container.attrs.get("NetworkSettings", {}) or {}).get("Networks", {}) or {}
    for network_name, network_data in networks.items():
        if network_name in worker_networks:
            continue
        network_id = str((network_data or {}).get("NetworkID") or network_name)
        try:
            network = client.networks.get(network_id)
            network.connect(worker_container)
            LOG.info("Connected worker to Docker network %s for ngrok tunnel", network_name)
        except Exception as error:
            LOG.warning("Could not connect worker to Docker network %s: %s", network_name, error)


def _host_port_target(container, internal_port: int) -> str:
    ports = (container.attrs.get("NetworkSettings", {}) or {}).get("Ports", {}) or {}
    preferred = ports.get(f"{internal_port}/tcp") or ports.get(f"{internal_port}/udp") or []
    mappings = preferred or next((items for items in ports.values() if items), [])
    if not mappings:
        return ""
    host_port = str((mappings[0] or {}).get("HostPort") or "").strip()
    if not host_port:
        return ""
    return f"http://host.docker.internal:{host_port}"


def _container_tunnel_target(container, fallback_port: int) -> str:
    internal_port = (_container_internal_ports(container) or [fallback_port])[0]
    host_target = _host_port_target(container, internal_port)
    if host_target:
        return host_target
    network_mode = str((container.attrs.get("HostConfig", {}) or {}).get("NetworkMode") or "").strip().lower()
    if network_mode == "host":
        return f"http://host.docker.internal:{fallback_port}"
    _connect_worker_to_container_networks(container)
    ip_address = _container_ip(container)
    if ip_address:
        return f"http://{ip_address}:{internal_port}"
    return ""


def _public_tunnel_targets(repository: dict, settings: Settings, only_service: str = "") -> dict[str, str]:
    client = docker_ops.connect()
    project = _safe_name(repository["alias"])
    fallback_port = int(repository.get("internalPort") or 3000)
    service_ports = _repository_public_tunnel_ports(repository)
    if repository.get("mode") == "compose":
        containers = client.containers.list(
            all=False,
            filters={"label": f"com.docker.compose.project={project}"},
        )
        running_services: dict[str, object] = {}
        for container in sorted(containers, key=lambda item: item.name):
            if container.status != "running":
                continue
            service = str(container.labels.get("com.docker.compose.service") or container.name).strip()
            if service and service not in running_services:
                running_services[service] = container
        if only_service and only_service not in running_services:
            available = ", ".join(sorted(running_services)) or "none"
            raise RuntimeError(
                f"Compose service '{only_service}' is not running for public tunnel '{project}'. "
                f"Running services: {available}"
            )
        service_containers = (
            {only_service: running_services[only_service]}
            if only_service
            else running_services
        )
        targets = {}
        for service, container in service_containers.items():
            target = _container_tunnel_target(container, service_ports.get(service, fallback_port))
            if target:
                targets[service] = target
        if targets:
            return targets
        unresolved = ", ".join(sorted(service_containers)) or "none"
        raise RuntimeError(
            f"Could not resolve a tunnel target for compose project '{project}' services: {unresolved}. "
            "Publish a port, configure the service internal port, or use a reachable Docker network."
        )
    try:
        container = client.containers.get(project)
    except NotFound:
        container = None
    if container and container.status == "running":
        target = _container_tunnel_target(container, fallback_port)
        if target:
            return {repository.get("service") or "app": target}
    raise RuntimeError(f"No running container found for public tunnel '{project}'")


def _repository_ngrok_authtoken(repository: dict, workspace_id: str, settings: Settings) -> str:
    repository_id = repository.get("id") or repository.get("alias")
    if repository_id:
        encrypted = reference(f"secrets/ngrok/{workspace_id}/{repository_id}").get()
        if encrypted:
            return decrypt_secret(encrypted, settings.encryption_key)
    return str(
        repository.get("ngrokAuthtoken")
        or repository.get("ngrokToken")
        or repository.get("ngrokApiKey")
        or ""
    ).strip()


def _ngrok_service(settings: Settings, authtoken: str = "") -> ngrok.NgrokService:
    token = authtoken.strip() or settings.ngrok_authtoken
    return ngrok.NgrokService(
        settings.data_dir,
        enabled=settings.ngrok_enabled or bool(token),
        authtoken=token,
        binary=settings.ngrok_bin,
        region=settings.ngrok_region,
    )


def _start_public_tunnel(repository: dict, workspace_id: str, settings: Settings, only_service: str = "", reset: bool = False) -> dict:
    project = _safe_name(repository["alias"])
    targets = _public_tunnel_targets(repository, settings, only_service=only_service)
    authtoken = _repository_ngrok_authtoken(repository, workspace_id, settings)
    service = _ngrok_service(settings, authtoken)
    service_domains = _repository_public_tunnel_domains(repository)
    single_domain = _repository_public_tunnel_domain(repository)
    existing_urls = repository.get("publicUrls") if isinstance(repository.get("publicUrls"), dict) else {}
    existing_tunnels = repository.get("publicTunnels") if isinstance(repository.get("publicTunnels"), dict) else {}
    public_urls = dict(existing_urls) if only_service else {}
    public_tunnels = dict(existing_tunnels) if only_service else {}
    for service_name, target in targets.items():
        is_compose = repository.get("mode") == "compose"
        tunnel_key = f"{project}--{_safe_name(service_name)}" if is_compose else project
        if reset:
            service.stop(tunnel_key)
            if is_compose:
                service.stop(project)
        domain = service_domains.get(service_name, "")
        if len(targets) == 1 and not domain:
            domain = single_domain
        tunnel = service.start(tunnel_key, target, domain=domain)
        public_urls[service_name] = tunnel.url
        public_tunnels[service_name] = {
            "url": tunnel.url,
            "target": tunnel.target,
            "domain": tunnel.domain,
            "pid": tunnel.pid,
            "workerId": settings.worker_id,
            "workerLabel": settings.worker_label,
            "updatedAt": _now(),
        }
    first_service = str(repository.get("service") or "") if repository.get("service") in public_urls else next(iter(public_urls))
    return {
        "publicUrl": public_urls[first_service],
        "publicUrls": public_urls,
        "publicTunnels": public_tunnels,
        "publicTunnelStatus": "online",
        "publicTunnelTarget": public_tunnels[first_service]["target"],
        "publicTunnelWorkerId": settings.worker_id,
        "publicTunnelWorkerLabel": settings.worker_label,
        "publicTunnelUpdatedAt": _now(),
    }


def _stop_public_tunnel(repository: dict, settings: Settings) -> dict:
    _ngrok_service(settings).stop_prefix(_safe_name(repository["alias"]))
    return {
        "publicUrl": "",
        "publicUrls": {},
        "publicTunnels": {},
        "publicTunnelStatus": "stopped",
        "publicTunnelTarget": "",
        "publicTunnelWorkerId": "",
        "publicTunnelUpdatedAt": _now(),
    }


def _public_urls_message(public_urls: object) -> str:
    urls = public_urls if isinstance(public_urls, dict) else {}
    rendered = ", ".join(f"{service}: {url}" for service, url in sorted(urls.items()) if url)
    return f"Public URLs ready: {len(urls)}" + (f". {rendered}" if rendered else "")


def execute_container_tunnel(job: dict, settings: Settings) -> tuple[str, dict]:
    client = docker_ops.connect()
    last_error = None
    for candidate in _container_lookup_candidates(job):
        try:
            container = client.containers.get(candidate)
            break
        except NotFound as error:
            last_error = error
    else:
        raise last_error or ValueError("Container reference is missing")
    if _is_worker_container_object(container):
        raise ValueError("Worker containers cannot be exposed publicly")
    if container.status != "running":
        raise ValueError("Container must be running to create a public URL")
    fallback_port = max(1, min(65535, int(job.get("internalPort") or 3000)))
    target = _container_tunnel_target(container, fallback_port)
    if not target:
        raise RuntimeError(
            f"Could not resolve a tunnel target for local container '{container.name}'. "
            "Publish a port or expose a reachable internal port."
        )
    tunnel_key = _safe_name(f"container-{settings.worker_id}-{container.name}")
    service = _ngrok_service(settings)
    if job.get("tunnelReset"):
        service.stop(tunnel_key)
    tunnel = service.start(tunnel_key, target)
    return f"Public URL ready for local container '{container.name}': {tunnel.url}", {
        "publicUrl": tunnel.url,
        "publicUrls": {"container": tunnel.url},
        "publicTunnelStatus": "online",
        "publicTunnelTarget": tunnel.target,
        "publicTunnelWorkerId": settings.worker_id,
        "publicTunnelWorkerLabel": settings.worker_label,
        "publicTunnelUpdatedAt": _now(),
    }


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
    if not environment:
        return None
    project = _safe_name(repository["alias"])
    configured_service = repository.get("service", "web")
    service_names = _compose_service_names(compose_file) or [configured_service]
    override_dir = settings.data_dir / "overrides"
    override_dir.mkdir(parents=True, exist_ok=True)
    override = override_dir / f"{project}.environment.yml"
    service_payloads: dict[str, dict[str, object]] = {}
    for service in service_names:
        service_payloads[service] = {"environment": environment}
    payload: dict[str, object] = {"services": service_payloads}
    override.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return override


def _configured_port_bindings(value: str) -> set[tuple[int, str]]:
    bindings: set[tuple[int, str]] = set()
    for raw_entry in re.split(r"[\s,]+", str(value or "").strip()):
        if not raw_entry:
            continue
        match = re.fullmatch(r"(\d+):(\d+)(?:/(tcp|udp))?", raw_entry, re.IGNORECASE)
        if not match:
            raise ValueError(f"Invalid port mapping '{raw_entry}'. Use host:container, for example 8080:80")
        host_port, container_port = int(match.group(1)), int(match.group(2))
        if not 1 <= host_port <= 65535 or not 1 <= container_port <= 65535:
            raise ValueError(f"Invalid port mapping '{raw_entry}'. Ports must be between 1 and 65535")
        binding = (host_port, (match.group(3) or "tcp").lower())
        if binding in bindings:
            raise ValueError(f"Port {host_port}/{binding[1]} is declared more than once")
        bindings.add(binding)
    return bindings


def _compose_port_bindings(command: list[str], path: Path, environment: dict[str, str]) -> set[tuple[int, str]]:
    process = subprocess.run(
        [*command, "config", "--format", "json"],
        cwd=path,
        capture_output=True,
        text=True,
        timeout=60,
        env=os.environ | environment,
    )
    if process.returncode:
        raise RuntimeError(_compact_process_error(process.stderr, process.stdout))
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Docker Compose returned invalid JSON while validating published ports") from error
    bindings: set[tuple[int, str]] = set()
    services = payload.get("services", {}) if isinstance(payload, dict) else {}
    for service in services.values() if isinstance(services, dict) else []:
        ports = service.get("ports", []) if isinstance(service, dict) else []
        for item in ports if isinstance(ports, list) else []:
            if not isinstance(item, dict) or item.get("published") in (None, ""):
                continue
            published = str(item["published"])
            bounds = published.split("-", 1)
            try:
                first = int(bounds[0])
                last = int(bounds[-1])
            except ValueError as error:
                raise ValueError(f"Invalid Compose published port '{published}'") from error
            if not 1 <= first <= last <= 65535:
                raise ValueError(f"Invalid Compose published port '{published}'")
            protocol = str(item.get("protocol") or "tcp").lower()
            if protocol not in {"tcp", "udp"}:
                continue
            bindings.update((port, protocol) for port in range(first, last + 1))
    return bindings


def _container_bound_ports(container) -> set[tuple[int, str]]:
    result: set[tuple[int, str]] = set()
    ports = (container.attrs.get("NetworkSettings", {}) or {}).get("Ports", {}) or {}
    for container_port, mappings in ports.items():
        protocol = str(container_port).split("/", 1)[1].lower() if "/" in str(container_port) else "tcp"
        for mapping in mappings or []:
            try:
                host_port = int(str((mapping or {}).get("HostPort") or ""))
            except ValueError:
                continue
            if host_port:
                result.add((host_port, protocol))
    return result


def _validate_deployment_ports(client, project: str, requested: set[tuple[int, str]]) -> None:
    if not requested:
        return
    for container in client.containers.list(all=False):
        labels = container.labels or {}
        if labels.get("com.docker.compose.project") == project or container.name == project:
            continue
        conflicts = requested & _container_bound_ports(container)
        if conflicts:
            ports = ", ".join(f"{port}/{protocol}" for port, protocol in sorted(conflicts))
            raise RuntimeError(
                f"Deployment port collision: {ports} already bound by running container '{container.name}'"
            )


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
    if not down:
        requested_ports = _compose_port_bindings(command, path, environment)
        _validate_deployment_ports(docker_ops.connect(), project, requested_ports)
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
    requested_ports = _configured_port_bindings(repository.get("ports", ""))
    _validate_deployment_ports(client, project, requested_ports)
    dockerfile = _repository_file(
        path,
        repository.get("dockerfile", ""),
        "Dockerfile",
        "Dockerfile",
        must_exist=True,
    )
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
            message = _run_compose(repository, path, settings, environment, down=True)
            return message, _stop_public_tunnel(repository, settings)
        client = docker_ops.connect()
        client.containers.get(_safe_name(repository["alias"])).remove(force=True)
        return "Container stopped", _stop_public_tunnel(repository, settings)
    if action == "tunnel_stop":
        return "Public URL closed", _stop_public_tunnel(repository, settings)
    if action == "tunnel_start":
        updates = _start_public_tunnel(
            repository,
            workspace_id,
            settings,
            only_service=str(job.get("tunnelService") or "").strip(),
            reset=bool(job.get("tunnelReset")),
        )
        return _public_urls_message(updates.get("publicUrls")), updates
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
        message = _run_compose(repository, path, settings, environment)
    else:
        message = _run_dockerfile(repository, path, settings, environment)
    updates = _start_public_tunnel(repository, workspace_id, settings) if _repository_public_tunnel_enabled(repository) else {}
    if updates.get("publicUrls"):
        message = f"{message}. {_public_urls_message(updates['publicUrls'])}"
    return message, updates


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
