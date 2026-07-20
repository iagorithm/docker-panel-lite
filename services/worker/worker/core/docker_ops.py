from __future__ import annotations

from pathlib import Path

try:
    import docker
except ImportError:
    docker = None


class DockerUnavailableError(Exception):
    pass


def connect() -> docker.DockerClient:
    if docker is None:
        raise DockerUnavailableError("The Docker SDK is not installed.")
    try:
        return docker.from_env()
    except Exception as error:
        raise DockerUnavailableError(str(error)) from error


def write_env_file(repo_path: str, env_lines: list[str]) -> None:
    content = "\n".join(env_lines)
    Path(repo_path, ".env").write_text((content + "\n") if content else "", encoding="utf-8")
