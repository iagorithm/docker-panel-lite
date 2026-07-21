from __future__ import annotations

import re
from pathlib import PurePosixPath


def parse_ports(port_str: str) -> dict[str, int]:
    ports: dict[str, int] = {}
    for pair in re.split(r"[\s,]+", (port_str or "").strip()):
        if not pair:
            continue
        match = re.fullmatch(r"(\d+):(\d+)(?:/(tcp|udp))?", pair, re.IGNORECASE)
        if not match:
            continue
        host, container = int(match.group(1)), int(match.group(2))
        protocol = (match.group(3) or "tcp").lower()
        ports[f"{container}/{protocol}"] = host
    return ports


def validate_relative_file_path(value: str) -> bool:
    candidate = (value or "").strip()
    if not candidate or candidate.endswith("/") or candidate.startswith("~"):
        return False
    if "\x00" in candidate or "\\" in candidate:
        return False
    path = PurePosixPath(candidate)
    return not path.is_absolute() and ".." not in path.parts and bool(path.name)
