from __future__ import annotations

from pathlib import PurePosixPath


def parse_ports(port_str: str) -> dict[str, int]:
    ports: dict[str, int] = {}
    for pair in (port_str or "").split(","):
        pair = pair.strip()
        if ":" not in pair:
            continue
        host, container = (item.strip() for item in pair.split(":", 1))
        if not host or not container:
            continue
        try:
            ports[f"{container}/tcp"] = int(host)
        except ValueError:
            continue
    return ports


def validate_relative_file_path(value: str) -> bool:
    candidate = (value or "").strip()
    if not candidate or candidate.endswith("/") or candidate.startswith("~"):
        return False
    if "\x00" in candidate or "\\" in candidate:
        return False
    path = PurePosixPath(candidate)
    return not path.is_absolute() and ".." not in path.parts and bool(path.name)
