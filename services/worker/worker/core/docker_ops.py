from __future__ import annotations

import re
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


SAFE_ENV_VALUE = re.compile(r"^[A-Za-z0-9_./:@%+=,-]*$")


def _format_env_line(key: str, value: str) -> str:
    text = str(value).replace("\x00", "")
    if SAFE_ENV_VALUE.match(text):
        return f"{key}={text}"
    escaped = text.replace("\\", "\\\\").replace("'", "\\'").replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    return f"{key}='{escaped}'"


def write_env_file(repo_path: str, environment: dict[str, str]) -> None:
    content = "\n".join(_format_env_line(key, value) for key, value in environment.items())
    Path(repo_path, ".env").write_text((content + "\n") if content else "", encoding="utf-8")
