"""Docker operations (build, compose, containers) isolated from the UI.

Centralizes interaction with the Docker SDK and the `docker compose` CLI so
the presentation layer does not contain orchestration logic.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

try:
    import docker
except ImportError:  # The SDK is only required at runtime inside the container.
    docker = None


class DockerUnavailableError(Exception):
    """Could not connect to the Docker daemon."""


def connect() -> docker.DockerClient:
    """Connect to the Docker daemon or raise DockerUnavailableError."""
    if docker is None:
        raise DockerUnavailableError("The Docker SDK is not installed in this environment.")
    try:
        return docker.from_env()
    except Exception as e:  # noqa: BLE001
        raise DockerUnavailableError(str(e)) from e


@dataclass
class ComposeResult:
    ok: bool
    stdout: str
    stderr: str


def compose_up(repo_path: str, project: str, compose_file: str, env_lines: list[str], timeout: int = 900) -> ComposeResult:
    """Bring up a stack with docker compose (up -d --build)."""
    _write_env_file(repo_path, env_lines)
    env = dict(os.environ)
    for line in env_lines:
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    try:
        result = subprocess.run(
            ["docker", "compose", "-p", project, "-f", compose_file, "up", "-d", "--build"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError as e:
        raise DockerUnavailableError(
            "The 'docker compose' binary is not available in this container. Check the panel Dockerfile."
        ) from e
    except subprocess.TimeoutExpired as e:
        raise DockerUnavailableError("Timed out building the stack") from e
    return ComposeResult(result.returncode == 0, result.stdout, result.stderr)


def compose_down(repo_path: str, project: str, compose_file: str, timeout: int = 300) -> ComposeResult:
    """Stop and remove a docker compose stack."""
    try:
        result = subprocess.run(
            ["docker", "compose", "-p", project, "-f", compose_file, "down"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as e:
        raise DockerUnavailableError(
            "The 'docker compose' binary is not available in this container. Check the panel Dockerfile."
        ) from e
    return ComposeResult(result.returncode == 0, result.stdout, result.stderr)


def build_and_run(client: docker.DockerClient, repo_path: str, dockerfile: str, tag: str, name: str, ports: dict, environment: list) -> str:
    """Build an image from a Dockerfile and run the container.

    Replaces any previous container with the same name.
    Returns the short_id of the created container.
    """
    image, _ = client.images.build(
        path=repo_path,
        dockerfile=dockerfile,
        tag=tag,
        rm=True,
    )
    try:
        old = client.containers.get(name)
        old.remove(force=True)
    except docker.errors.NotFound:
        pass
    container = client.containers.run(
        image.id,
        name=name,
        ports=ports or None,
        environment=environment or None,
        detach=True,
    )
    return container.short_id


def _write_env_file(repo_path: str, env_lines: list[str]) -> None:
    """Dump environment variables to a .env next to the compose file."""
    if env_lines:
        from pathlib import Path

        Path(repo_path, ".env").write_text("\n".join(env_lines) + "\n")
