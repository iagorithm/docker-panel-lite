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
from urllib.parse import urlparse


URL_PATTERN = re.compile(r"https://[^\s\"']+")
NGROK_ERROR_PATTERN = re.compile(r"ERR_NGROK_\d+", re.IGNORECASE)
NGROK_CONTROL_HOSTS = {"dashboard.ngrok.com", "ngrok.com", "www.ngrok.com"}


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


def _public_tunnel_url(candidate: str, domain: str = "") -> bool:
    try:
        parsed = urlparse(candidate.rstrip(","))
        hostname = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    requested_host = (urlparse(f"https://{domain.removeprefix('https://').removeprefix('http://')}").hostname or "").lower().rstrip(".") if domain else ""
    if parsed.scheme != "https" or not hostname or hostname in NGROK_CONTROL_HOSTS or "/billing/" in parsed.path.lower():
        return False
    if requested_host:
        return hostname == requested_host
    return hostname.endswith((".ngrok.app", ".ngrok-free.app", ".ngrok.io"))


def _ngrok_error_message(error_code: str) -> str:
    code = error_code.upper()
    exact = {
        "ERR_NGROK_102": "The last payment for this ngrok account failed. Update the payment method in the ngrok billing dashboard.",
        "ERR_NGROK_103": "This ngrok account is suspended. Review the account status or contact ngrok support.",
        "ERR_NGROK_105": "The saved value is not a valid ngrok authtoken. Copy a new authtoken from the ngrok dashboard and save the project again.",
        "ERR_NGROK_106": "The saved credential is a legacy ngrok v1 token and is not supported. Generate a current authtoken and save the project again.",
        "ERR_NGROK_107": "The authtoken is invalid, reset, revoked, or belongs to a team the user can no longer access. Generate and save a new token.",
        "ERR_NGROK_108": "The account reached its simultaneous ngrok agent-session limit. Stop an active Public URL or agent at https://dashboard.ngrok.com/agents, then retry; otherwise upgrade the account. Each worker ngrok process counts as one session.",
        "ERR_NGROK_115": "This worker's public IP is blocked by the ngrok account's Agent IP Restrictions. Allow the worker IP in the ngrok dashboard.",
        "ERR_NGROK_120": "The ngrok agent in the worker image is no longer supported. Rebuild the worker with a current ngrok release.",
        "ERR_NGROK_247": "The ngrok account is suspended for non-payment. Pay the outstanding balance in the ngrok billing dashboard.",
        "ERR_NGROK_300": "The ngrok authtoken credential has been revoked. Generate and save a new project token.",
        "ERR_NGROK_307": "The configured ngrok address must be reserved in this account before it can be used.",
        "ERR_NGROK_309": "The configured ngrok address is reserved by another account. Clear it or use a domain owned by this token's account.",
        "ERR_NGROK_314": "The ngrok account is on the Free plan or another plan that cannot create a custom hostname. Clear the configured Ngrok domain to use an automatically generated *.ngrok-free.app URL, or upgrade the account.",
        "ERR_NGROK_319": "The configured custom hostname is not reserved in this ngrok account. Reserve it first or clear the Ngrok domain field.",
        "ERR_NGROK_320": "The configured domain is reserved by another ngrok account. Use the token for the owning account or choose another domain.",
        "ERR_NGROK_324": "The ngrok agent session reached its endpoint limit. Stop an endpoint or upgrade the ngrok account.",
        "ERR_NGROK_334": "The configured endpoint is already online in another ngrok agent. Stop the existing endpoint before retrying.",
        "ERR_NGROK_400": "The configured ngrok region is invalid. Correct or remove NGROK_REGION in the worker configuration.",
        "ERR_NGROK_8012": "ngrok is online, but it cannot connect to the application upstream. Confirm the container is running, the internal port is correct, and the service is reachable from the worker.",
        "ERR_NGROK_8013": "This free ngrok account requires a payment card before it can open TCP endpoints.",
        "ERR_NGROK_8014": "ngrok blocked this agent for a suspected Acceptable Use Policy violation. Review the account and contact ngrok support.",
    }
    if code in exact:
        return f"{code}: {exact[code]}"
    number = int(code.rsplit("_", 1)[-1])
    if number in {310, 313, 315, 401}:
        detail = "The configured domain feature is not available on this ngrok plan. Clear the Ngrok domain field or upgrade the account."
    elif number in {308, 316}:
        detail = "The authtoken credential policy does not permit using the configured domain. Review the credential ACL or use another token."
    elif number in {311, 317, 322}:
        detail = "The configured domain and worker region do not match. Correct NGROK_REGION or select a domain available in that region."
    elif number in {326, 327, 347, 354, 355, 396, 397}:
        detail = "The configured Ngrok domain is invalid. Correct it or clear the field to request an automatically generated URL."
    elif number in {337, 338}:
        detail = "The ngrok account has a billing or suspension problem. Review the account status and billing dashboard."
    elif number in {348, 349}:
        detail = "The ngrok account reached a session limit or session creation rate limit. Stop an active agent, wait, or upgrade the account."
    elif number in {350, 351}:
        detail = "The ngrok account reached an endpoint limit or endpoint creation rate limit. Stop an endpoint, wait, or upgrade the account."
    elif number == 3208:
        detail = "The ngrok account was banned for a Terms of Service violation. Contact ngrok support if this is unexpected."
    elif 8000 <= number <= 8011:
        detail = "The worker could not establish ngrok network connectivity. Check DNS, outbound internet, proxy, firewall, TLS inspection, and IPv6 configuration."
    else:
        detail = f"ngrok rejected the tunnel request. See https://ngrok.com/docs/errors/{code.lower()} for the exact account or configuration requirement."
    return f"{code}: {detail}"
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
        domain = str(state.get("domain") or "")
        if not url or not target or not _public_tunnel_url(url, domain):
            return None
        return Tunnel(
            url=url,
            target=target,
            pid=pid,
            domain=domain,
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
                error_code = NGROK_ERROR_PATTERN.search(log_text)
                if error_code:
                    process.terminate()
                    raise NgrokError(_ngrok_error_message(error_code.group(0)))
                urls = [item.rstrip(",") for item in URL_PATTERN.findall(log_text)]
                public_url = next((item for item in urls if _public_tunnel_url(item, domain)), "")
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
