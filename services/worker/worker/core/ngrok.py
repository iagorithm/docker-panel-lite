from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


URL_PATTERN = re.compile(r"https://[^\s\"']+")


class NgrokError(RuntimeError):
    pass


@dataclass(frozen=True)
class Tunnel:
    url: str
    target: str
    pid: int
    domain: str = ""
    started_at: int = 0


def _now() -> int:
    return int(time.time() * 1000)


def _safe_project(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-") or "project"


def _pid_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class NgrokService:
    def __init__(
        self,
        data_dir: Path,
        *,
        enabled: bool,
        authtoken: str = "",
        binary: str = "ngrok",
        region: str = "",
    ):
        self.enabled = enabled
        self.authtoken = authtoken.strip()
        self.binary = binary.strip() or "ngrok"
        self.region = region.strip()
        self.root = data_dir / "ngrok"
        self.root.mkdir(parents=True, exist_ok=True)

    def _paths(self, project: str) -> tuple[Path, Path]:
        key = _safe_project(project)
        return self.root / f"{key}.json", self.root / f"{key}.log"

    def _binary_path(self) -> str:
        resolved = shutil.which(self.binary)
        if not resolved:
            raise NgrokError("ngrok is not installed in this worker image")
        return resolved

    def _read_state(self, project: str) -> dict:
        state_path, _log_path = self._paths(project)
        try:
            payload = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return payload if isinstance(payload, dict) else {}

    def current(self, project: str) -> Tunnel | None:
        state = self._read_state(project)
        pid = int(state.get("pid") or 0)
        if not _pid_running(pid):
            return None
        url = str(state.get("url") or "")
        target = str(state.get("target") or "")
        if not url or not target:
            return None
        return Tunnel(
            url=url,
            target=target,
            pid=pid,
            domain=str(state.get("domain") or ""),
            started_at=int(state.get("startedAt") or 0),
        )

    def stop(self, project: str) -> None:
        state_path, _log_path = self._paths(project)
        state = self._read_state(project)
        pid = int(state.get("pid") or 0)
        if _pid_running(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            deadline = time.time() + 5
            while time.time() < deadline and _pid_running(pid):
                time.sleep(0.15)
            if _pid_running(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
        try:
            state_path.unlink()
        except FileNotFoundError:
            pass

    def stop_prefix(self, project: str) -> None:
        prefix = f"{_safe_project(project)}--"
        self.stop(project)
        for state_path in self.root.glob(f"{prefix}*.json"):
            self.stop(state_path.stem)

    def start(self, project: str, target: str, *, domain: str = "") -> Tunnel:
        if not self.enabled:
            raise NgrokError("ngrok is disabled. Set NGROK_ENABLED=true and NGROK_AUTHTOKEN in the worker environment.")
        if not self.authtoken and not os.getenv("NGROK_CONFIG", "").strip():
            raise NgrokError("NGROK_AUTHTOKEN is required to open public tunnels")
        current = self.current(project)
        if current and current.target == target and current.domain == domain:
            return current
        self.stop(project)

        state_path, log_path = self._paths(project)
        command = [
            self._binary_path(),
            "http",
            target,
            "--log=stdout",
            "--log-format=logfmt",
        ]
        if domain:
            command.append(f"--url={domain}")
        if self.region:
            command.append(f"--region={self.region}")
        env = os.environ.copy()
        if self.authtoken:
            env["NGROK_AUTHTOKEN"] = self.authtoken
        log_handle = log_path.open("w", encoding="utf-8")
        process = subprocess.Popen(
            command,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env=env,
        )
        log_handle.close()

        deadline = time.time() + 30
        public_url = ""
        log_text = ""
        while time.time() < deadline:
            if log_path.exists():
                log_text = log_path.read_text(encoding="utf-8", errors="replace")[-20_000:]
                urls = [item.rstrip(",") for item in URL_PATTERN.findall(log_text)]
                public_url = next((item for item in urls if domain and domain in item), "") or next(
                    (item for item in urls if "ngrok" in item.lower()),
                    "",
                )
                if public_url:
                    break
            if process.poll() is not None:
                raise NgrokError((log_text.strip() or "ngrok exited before creating a tunnel")[-2000:])
            time.sleep(0.5)

        if not public_url:
            self.stop(project)
            raise NgrokError((log_text.strip() or "ngrok did not publish a URL within 30 seconds")[-2000:])

        state = {
            "pid": process.pid,
            "url": public_url,
            "target": target,
            "domain": domain,
            "startedAt": _now(),
            "logPath": str(log_path),
        }
        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        return Tunnel(url=public_url, target=target, pid=process.pid, domain=domain, started_at=state["startedAt"])
