from __future__ import annotations

import concurrent.futures
import hashlib
import logging
import os
import platform
import re
import secrets as token_secrets
import signal
import sys
import threading
import time
import traceback

from worker.config import Settings
from worker.core import docker_ops
from worker.executor import container_inventory, execute, execute_container, execute_container_command, execute_container_tunnel, execute_worker_command
from worker.firebase_runtime import initialize, reference

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("deployment-worker")

WORKER_NAMES = (
    "Mexica", "London", "Paris", "Africa", "Kyoto", "Cairo", "Lima", "Nairobi", "Oslo", "Berlin",
    "Tokyo", "Seoul", "Lisbon", "Madrid", "Roma", "Athens", "Vienna", "Prague", "Dublin", "Zurich",
    "Havana", "Bogota", "Quito", "Andes", "Amazonas", "Patagonia", "Sahara", "Kalahari", "Atlas", "Nile",
    "Ganges", "Yukon", "Tundra", "Aurora", "Boreal", "Maya", "Inca", "Aztec", "Olmec", "Zapotec",
    "Tenochtitlan", "Uxmal", "Teotihuacan", "Chichen", "Palenque", "Oaxaca", "Sonora", "Yucatan", "Tulum", "Merida",
    "Barcelona", "Valencia", "Monaco", "Venice", "Florence", "Milan", "Napoli", "Sicilia", "Corsica", "Malta",
    "Casablanca", "Marrakesh", "Tunis", "Accra", "Lagos", "Kigali", "Zanzibar", "Serengeti", "Kilimanjaro", "Mombasa",
    "Mumbai", "Delhi", "Goa", "Jaipur", "Bali", "Java", "Sumatra", "Manila", "Saigon", "Hanoi",
    "Sydney", "Melbourne", "Auckland", "Tahiti", "Samoa", "Fiji", "Honolulu", "Alaska", "Vancouver", "Montreal",
    "Brooklyn", "Chicago", "Austin", "Denver", "Phoenix", "Seattle", "Portland", "Boston", "Miami", "Orleans",
)


def now_ms() -> int:
    return int(time.time() * 1000)


def normalized_name(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum())


def container_record_id(worker_id: str, container_name: str) -> str:
    safe_name = "".join(character if character.isalnum() or character in "-_" else "-" for character in container_name).strip("-")
    return f"{worker_id}--{safe_name or 'container'}"


def job_action_label(action: str) -> str:
    return {
        "sync": "sync repository",
        "deploy": "deploy compose stack",
        "build": "build Dockerfile container",
        "stop": "stop repository",
        "discover_branches": "discover branches",
        "read_compose": "read Compose file",
        "inventory_refresh": "refresh container inventory",
        "container_start": "start container",
        "container_stop": "stop container",
        "container_restart": "restart container",
        "container_delete": "delete container",
        "container_logs": "load container logs",
        "container_exec": "run container command",
        "container_tunnel_start": "open public URL for local container",
        "worker_command": "run worker command",
        "tunnel_start": "open public URL",
        "tunnel_stop": "close public URL",
    }.get(action, action)


def job_subject(job: dict, repository: dict | None = None) -> str:
    if repository:
        return str(repository.get("alias") or repository.get("id") or job.get("repositoryId") or "repository")
    return str(job.get("containerRef") or job.get("containerId") or job.get("repositoryId") or "workspace")


class Worker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.worker_label = settings.worker_label
        self.started_at = now_ms()
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.active: set[str] = set()
        self.lock = threading.Lock()
        self.shutdown_notice_sent = False
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=settings.max_concurrency, thread_name_prefix="job")
        self.listeners = []
        self._docker_cache: tuple[int, dict] = (0, {})
        self.worker_token = self._resolve_worker_token()
        self.worker_token_hash = hashlib.sha256(self.worker_token.encode("utf-8")).hexdigest()

    def _record_app_error(self, action: str, error: object, *, source: str, job: dict | None = None) -> None:
        try:
            message = re.sub(r"([?&](?:access_token|token|key)=)[^&\s]+", r"\1[REDACTED]", str(error) or "Unknown worker error", flags=re.IGNORECASE)[:2000]
            function_name = source
            error_traceback = getattr(error, "__traceback__", None)
            if error_traceback:
                frame = traceback.extract_tb(error_traceback)[-1]
                function_name = f"{os.path.basename(frame.filename)}:{frame.name}:{frame.lineno}"
            log_ref = reference(f"workspaces/{self.settings.workspace_id}/app_logs").push()
            log_ref.set({
                "id": log_ref.key,
                "actorType": "worker",
                "actorId": self.settings.worker_id,
                "actorLabel": self.worker_label or "",
                "userId": str((job or {}).get("requestedBy") or ""),
                "userEmail": str((job or {}).get("requestedByEmail") or ""),
                "runtime": "worker-python",
                "functionName": function_name[:240],
                "action": str(action or "worker_runtime")[:120],
                "source": str(source or "worker")[:160],
                "severity": "error",
                "message": message,
                "context": {
                    "jobId": str((job or {}).get("id") or ""),
                    "repositoryId": str((job or {}).get("repositoryId") or ""),
                    "containerId": str((job or {}).get("containerId") or ""),
                    "targetWorkerId": str((job or {}).get("targetWorkerId") or ""),
                    "requestedBy": str((job or {}).get("requestedBy") or ""),
                    "requestedByEmail": str((job or {}).get("requestedByEmail") or ""),
                },
                "createdAt": now_ms(),
            })
        except Exception as reporting_error:
            LOG.warning("Could not publish app log: %s", reporting_error)

    def _resolve_worker_token(self) -> str:
        configured = os.getenv("WORKER_TOKEN", "").strip()
        if configured:
            return configured
        marker = self.settings.data_dir / "worker-token"
        try:
            self.settings.data_dir.mkdir(parents=True, exist_ok=True)
            if marker.is_file():
                saved = marker.read_text(encoding="utf-8").strip()
                if saved:
                    return saved
            generated = token_secrets.token_urlsafe(24)
            marker.write_text(generated + "\n", encoding="utf-8")
            try:
                marker.chmod(0o600)
            except OSError:
                pass
            return generated
        except OSError:
            return token_secrets.token_urlsafe(24)

    def _docker_summary(self) -> dict:
        timestamp = now_ms()
        cached_at, cached = self._docker_cache
        if cached and timestamp - cached_at < 60_000:
            return cached
        try:
            client = docker_ops.connect()
            version = client.version()
            info = client.info()
            summary = {
                "available": True,
                "serverVersion": str(version.get("Version", "")),
                "apiVersion": str(version.get("ApiVersion", "")),
                "os": str(info.get("OperatingSystem", "")),
                "architecture": str(info.get("Architecture", "")),
                "containers": int(info.get("Containers", 0) or 0),
                "containersRunning": int(info.get("ContainersRunning", 0) or 0),
                "images": int(info.get("Images", 0) or 0),
            }
        except Exception as error:
            summary = {"available": False, "error": str(error)[:240]}
        self._docker_cache = (timestamp, summary)
        return summary

    def _worker_payload(self, status: str, active_jobs: int) -> dict:
        existing = {}
        try:
            existing = reference(f"workspaces/{self.settings.workspace_id}/agents/{self.settings.worker_id}").get() or {}
        except Exception:
            existing = {}
        sharing = existing.get("sharing") if isinstance(existing, dict) else None
        if sharing not in {"private", "shared", "public"}:
            sharing = "private"
        return {
            "id": self.settings.worker_id,
            "identitySource": self.settings.worker_identity_source,
            "label": self.worker_label,
            "hostname": self.settings.hostname,
            "location": self.settings.worker_location,
            "poolId": self.settings.pool_id,
            "status": status,
            "activeJobs": active_jobs,
            "maxConcurrency": self.settings.max_concurrency,
            "shards": list(self.settings.shards),
            "lastHeartbeat": now_ms(),
            "startedAt": self.started_at,
            "pid": os.getpid(),
            "pythonVersion": platform.python_version(),
            "platform": platform.platform(),
            "system": platform.system(),
            "machine": platform.machine(),
            "executable": sys.executable,
            "cloneDir": str(self.settings.clone_dir),
            "dataDir": str(self.settings.data_dir),
            "ngrokEnabled": self.settings.ngrok_enabled,
            "ngrokRegion": self.settings.ngrok_region,
            "leaseSeconds": self.settings.lease_seconds,
            "pollSeconds": self.settings.poll_seconds,
            "docker": self._docker_summary(),
            "sharing": sharing,
            "shared": sharing in {"shared", "public"},
            "public": sharing == "public",
            "sharingUpdatedAt": existing.get("sharingUpdatedAt") if isinstance(existing, dict) else None,
            "sharingUpdatedBy": existing.get("sharingUpdatedBy") if isinstance(existing, dict) else "",
            "workerTokenHash": self.worker_token_hash,
            "claimedAt": existing.get("claimedAt") if isinstance(existing, dict) else None,
            "claimedBy": existing.get("claimedBy") if isinstance(existing, dict) else "",
            "ownerUid": existing.get("ownerUid") if isinstance(existing, dict) else "",
            "ownerEmail": existing.get("ownerEmail") if isinstance(existing, dict) else "",
            "sharedEmails": existing.get("sharedEmails") if isinstance(existing, dict) else [],
        }

    def _resolve_worker_label(self) -> str:
        try:
            agents = reference(f"workspaces/{self.settings.workspace_id}/agents").get() or {}
        except Exception:
            LOG.exception("Could not read worker labels")
            return self.worker_label or WORKER_NAMES[0]
        current = agents.get(self.settings.worker_id) if isinstance(agents, dict) else None
        if isinstance(current, dict):
            previous = str(current.get("label") or "").strip()
            if previous:
                return previous
        if self.worker_label:
            return self.worker_label
        used = set()
        if isinstance(agents, dict):
            for agent_id, agent in agents.items():
                if agent_id == self.settings.worker_id or not isinstance(agent, dict):
                    continue
                label = str(agent.get("label") or "").strip()
                if label:
                    used.add(normalized_name(label))
        suffix = 1
        while True:
            for name in WORKER_NAMES:
                candidate = name if suffix == 1 else f"{name}{suffix}"
                if normalized_name(candidate) not in used:
                    return candidate
            suffix += 1

    def start(self) -> None:
        self.worker_label = self._resolve_worker_label()
        LOG.info("Worker claim token for %s (%s): %s", self.settings.worker_id, self.worker_label or "unnamed", self.worker_token)
        self._heartbeat(reset_inventory=True)
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        for shard in self.settings.shards:
            self.listeners.append(reference(f"queues/{self.settings.pool_id}/{shard}").listen(lambda _event: self.wake_event.set()))
        LOG.info("Worker %s (%s) listening on pool=%s shards=%s", self.settings.worker_id, self.worker_label or "unnamed", self.settings.pool_id, ",".join(self.settings.shards))
        while not self.stop_event.is_set():
            try:
                self.scan()
            except Exception as error:
                LOG.exception("Worker scan failed")
                self._record_app_error("queue_scan", error, source="worker.scan")
            finally:
                self.wake_event.wait(self.settings.poll_seconds)
                self.wake_event.clear()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        for listener in self.listeners:
            try:
                listener.close()
            except Exception as error:
                LOG.exception("Could not close Firebase listener")
                self._record_app_error("worker_shutdown", error, source="worker.listener.close")
        self.pool.shutdown(wait=True, cancel_futures=False)
        try:
            self._heartbeat("offline")
        except Exception as error:
            LOG.exception("Could not mark worker offline")
            self._record_app_error("worker_shutdown", error, source="worker.offline")

    def request_stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        with self.lock:
            if self.shutdown_notice_sent:
                return
            self.shutdown_notice_sent = True
        threading.Thread(target=self._mark_stopping, daemon=True).start()

    def _mark_stopping(self) -> None:
        try:
            self._heartbeat("stopping")
        except Exception as error:
            LOG.exception("Could not mark worker stopping")
            self._record_app_error("worker_shutdown", error, source="worker.stopping")

    def _record_belongs_to_worker(self, record_id: str, item: dict) -> bool:
        if item.get("workerId") == self.settings.worker_id or record_id.startswith(f"{self.settings.worker_id}--"):
            return True
        if self.worker_label and normalized_name(str(item.get("workerLabel") or "")) == normalized_name(self.worker_label):
            return True
        return bool(self.settings.hostname and item.get("workerHostname") == self.settings.hostname)

    def _is_worker_container(self, docker_id: str, item: dict) -> bool:
        hostname = self.settings.hostname
        name = str(item.get("name") or "")
        compose_service = str(item.get("composeService") or "")
        normalized = normalized_name(name)
        if hostname and (docker_id.startswith(hostname) or name == hostname):
            return True
        if compose_service == "worker":
            return True
        return bool(re.search(r"(^|[-_])worker([-_]1)?$", normalized))

    def _heartbeat(self, status: str = "online", reset_inventory: bool = False) -> None:
        with self.lock:
            active_jobs = len(self.active)
        payload = self._worker_payload(status, active_jobs)
        if status == "stopping":
            payload["stoppingAt"] = now_ms()
        reference(f"workspaces/{self.settings.workspace_id}/agents/{self.settings.worker_id}").set(payload)
        if status == "online":
            try:
                self._publish_container_inventory(self.settings.workspace_id, reset_worker_records=reset_inventory)
            except Exception as error:
                LOG.exception("Container inventory failed")
                self._record_app_error("inventory_refresh", error, source="worker.heartbeat.inventory")

    def _publish_container_inventory(self, workspace_id: str, reset_worker_records: bool = False) -> None:
        inventory = container_inventory()
        existing = reference(f"workspaces/{workspace_id}/containers").get() or {}
        updates = {}
        seen_record_ids = set()
        now = now_ms()
        for docker_id, item in inventory.items():
            record_id = container_record_id(self.settings.worker_id, item.get("name", docker_id))
            previous = {} if reset_worker_records else (existing.get(record_id) or existing.get(docker_id) or {})
            seen_record_ids.add(record_id)
            is_worker_container = self._is_worker_container(docker_id, item)
            updated = {
                **previous,
                **item,
                "id": record_id,
                "dockerId": docker_id,
                "workerId": self.settings.worker_id,
                "workerLabel": self.worker_label,
                "workerHostname": self.settings.hostname,
                "poolId": self.settings.pool_id,
                "isWorkerContainer": is_worker_container,
                "protectedActions": ["container_stop", "container_delete", "container_exec"] if is_worker_container else [],
                "lastSeenAt": now,
                "updatedAt": now,
                "missingSince": None,
                "createdAt": previous.get("createdAt") or now,
            }
            if previous.get("logTail"):
                updated["logTail"] = previous["logTail"]
            updates[f"workspaces/{workspace_id}/containers/{record_id}"] = updated
            if docker_id != record_id and existing.get(docker_id):
                updates[f"workspaces/{workspace_id}/containers/{docker_id}"] = None
        for container_id, item in existing.items():
            if not isinstance(item, dict):
                continue
            if self._record_belongs_to_worker(container_id, item) and container_id not in seen_record_ids and container_id not in inventory:
                updates[f"workspaces/{workspace_id}/containers/{container_id}"] = None
                LOG.info("Removing stale container record %s for worker %s", container_id, self.worker_label or self.settings.worker_id)
        if updates:
            if reset_worker_records:
                LOG.info("Reset container records for worker %s with %s Docker containers", self.worker_label or self.settings.worker_id, len(inventory))
            reference().update(updates)

    def _heartbeat_loop(self) -> None:
        while not self.stop_event.wait(10):
            try:
                self._heartbeat()
            except Exception as error:
                LOG.exception("Heartbeat failed")
                self._record_app_error("heartbeat", error, source="worker.heartbeat")

    def scan(self) -> None:
        with self.lock:
            capacity = self.settings.max_concurrency - len(self.active)
        if capacity <= 0:
            return
        for shard in self.settings.shards:
            queued = reference(f"queues/{self.settings.pool_id}/{shard}").get() or {}
            if not isinstance(queued, dict):
                continue
            for job_id in sorted(queued, key=lambda item: (queued.get(item) or {}).get("createdAt", 0)):
                queue_item = queued.get(job_id) or {}
                if not isinstance(queue_item, dict):
                    reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
                    continue
                target_worker_id = queue_item.get("targetWorkerId")
                if target_worker_id and target_worker_id != self.settings.worker_id:
                    continue
                if capacity <= 0:
                    return
                with self.lock:
                    if job_id in self.active:
                        continue
                    self.active.add(job_id)
                self.pool.submit(self._process, job_id, shard)
                capacity -= 1

    def _claim(self, job_id: str) -> dict | None:
        timestamp = now_ms()
        def update(job):
            if not job or job.get("status") in {"completed", "failed", "cancelled"}:
                return job
            if job.get("targetWorkerId") and job.get("targetWorkerId") != self.settings.worker_id:
                return job
            lease_expired = int(job.get("leaseExpiresAt", 0)) < timestamp
            if job.get("status") not in {"queued", "leased", "running"} or (job.get("workerId") and not lease_expired):
                return job
            if job.get("cancellationRequested"):
                return {**job, "status": "cancelled", "finishedAt": timestamp, "message": "Cancelled before execution"}
            return {**job, "status": "leased", "workerId": self.settings.worker_id, "leaseExpiresAt": timestamp + self.settings.lease_seconds * 1000, "attempt": int(job.get("attempt", 0)) + 1, "startedAt": job.get("startedAt", timestamp)}
        try:
            claimed = reference(f"jobs/{job_id}").transaction(update)
        except ValueError as error:
            if "Value must not be none" in str(error):
                LOG.warning("Skipping orphaned queue item for missing job %s", job_id)
                return None
            raise
        return claimed if claimed and claimed.get("workerId") == self.settings.worker_id and claimed.get("status") == "leased" else None

    def _publish(self, job: dict, values: dict) -> None:
        job_id, workspace_id = job["id"], job["workspaceId"]
        update = {f"jobs/{job_id}/{key}": value for key, value in values.items()}
        update.update({f"workspaces/{workspace_id}/deployments/{job_id}/{key}": value for key, value in values.items()})
        reference().update(update)

    def _acquire_repository_lock(self, job: dict) -> bool:
        timestamp = now_ms()
        lock_key = job.get("repositoryId") or f"container-{job.get('containerId', 'unknown')}"
        lock_ref = reference(f"locks/{job['workspaceId']}/{lock_key}")
        def update(current):
            if current and int(current.get("expiresAt", 0)) >= timestamp and current.get("jobId") != job["id"]:
                return current
            return {"jobId": job["id"], "workerId": self.settings.worker_id, "expiresAt": timestamp + self.settings.lease_seconds * 1000}
        lock = lock_ref.transaction(update)
        return bool(lock and lock.get("jobId") == job["id"] and lock.get("workerId") == self.settings.worker_id)

    def _release_repository_lock(self, job: dict) -> None:
        lock_key = job.get("repositoryId") or f"container-{job.get('containerId', 'unknown')}"
        lock_ref = reference(f"locks/{job['workspaceId']}/{lock_key}")
        current = lock_ref.get()
        if current and current.get("jobId") == job["id"]:
            lock_ref.delete()

    def _process(self, job_id: str, shard: str) -> None:
        renewal_stop = threading.Event()
        job = None
        try:
            job = self._claim(job_id)
            if not job:
                current = reference(f"jobs/{job_id}").get() or {}
                if current.get("status") in {"completed", "failed", "cancelled"}:
                    reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
                elif not current:
                    reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
                return
            if job["workspaceId"] != self.settings.workspace_id:
                raise PermissionError("Worker is not assigned to this workspace")
            if not self._acquire_repository_lock(job):
                self._publish(job, {"status": "queued", "workerId": None, "leaseExpiresAt": None, "message": "Waiting for repository lock"})
                LOG.info("Job %s waiting for lock: %s", job_id, job_action_label(job.get("action", "")))
                return
            self._publish(job, {"status": "running", "progress": 10, "message": "Worker claimed deployment"})
            LOG.info("Job %s claimed: %s", job_id, job_action_label(job.get("action", "")))
            def renew():
                try:
                    while not renewal_stop.wait(max(10, self.settings.lease_seconds // 3)):
                        current = reference(f"jobs/{job_id}").get() or {}
                        if current.get("workerId") != self.settings.worker_id or current.get("cancellationRequested"):
                            return
                        self._publish(job, {"leaseExpiresAt": now_ms() + self.settings.lease_seconds * 1000})
                        lock_key = job.get("repositoryId") or f"container-{job.get('containerId', 'unknown')}"
                        reference(f"locks/{job['workspaceId']}/{lock_key}/expiresAt").set(now_ms() + self.settings.lease_seconds * 1000)
                except Exception as error:
                    LOG.exception("Lease renewal failed for job %s", job_id)
                    self._record_app_error(str((job or {}).get("action") or "lease_renewal"), error, source="worker.lease", job=job)
            threading.Thread(target=renew, daemon=True).start()
            self._publish(job, {"progress": 25, "message": f"Executing {job_action_label(job['action'])}"})
            if job["action"] == "inventory_refresh":
                LOG.info("Job %s running: refresh container inventory", job_id)
                self._publish_container_inventory(job["workspaceId"])
                message = "Container inventory refreshed"
            elif job["action"] == "worker_command":
                repository = None
                if job.get("repositoryId"):
                    repository = reference(f"workspaces/{job['workspaceId']}/repositories/{job['repositoryId']}").get()
                    if not repository:
                        raise ValueError("Repository no longer exists")
                LOG.info("Job %s running: worker command on %s", job_id, self.worker_label or self.settings.worker_id)
                message, command_output, exit_code = execute_worker_command(job, repository, self.settings)
                self._publish(job, {"commandOutput": command_output, "commandExitCode": exit_code})
                if exit_code:
                    raise RuntimeError(message)
            elif job["action"] == "container_exec":
                LOG.info("Job %s running: container command on %s", job_id, job_subject(job))
                message, command_output, exit_code = execute_container_command(job)
                self._publish(job, {"commandOutput": command_output, "commandExitCode": exit_code})
                if exit_code:
                    raise RuntimeError(message)
            elif job["action"] == "container_tunnel_start":
                LOG.info("Job %s running: create public URL for %s", job_id, job_subject(job))
                message, container_updates = execute_container_tunnel(job, self.settings)
                reference(f"workspaces/{job['workspaceId']}/containers/{job['containerId']}").update(container_updates)
            elif job["action"].startswith("container_"):
                LOG.info("Job %s running: %s on %s", job_id, job_action_label(job["action"]), job_subject(job))
                message, log_tail = execute_container(job)
                if log_tail is not None:
                    reference(f"workspaces/{job['workspaceId']}/containers/{job['containerId']}/logTail").set(log_tail)
                else:
                    self._publish_container_inventory(job["workspaceId"])
            else:
                repository_ref = reference(f"workspaces/{job['workspaceId']}/repositories/{job['repositoryId']}")
                repository = repository_ref.get()
                if not repository:
                    raise ValueError("Repository no longer exists")
                LOG.info("Job %s running: %s for %s", job_id, job_action_label(job["action"]), job_subject(job, repository))
                message, repository_updates = execute(job, repository, self.settings)
                if repository_updates:
                    repository_ref.update(repository_updates)
            current = reference(f"jobs/{job_id}").get() or {}
            status = "cancelled" if current.get("cancellationRequested") else "completed"
            self._publish(job, {"status": status, "progress": 100, "message": message, "finishedAt": now_ms(), "leaseExpiresAt": None})
            LOG.info("Job %s %s: %s", job_id, status, message)
            reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
        except Exception as error:
            LOG.error("Job %s failed: %s", job_id, error)
            LOG.debug("Job %s traceback:\n%s", job_id, traceback.format_exc())
            self._record_app_error(str((job or {}).get("action") or "unknown_job"), error, source="worker.job", job=job)
            try:
                job = reference(f"jobs/{job_id}").get() or job or {"id": job_id, "workspaceId": self.settings.workspace_id}
                self._publish(job, {"status": "failed", "message": str(error)[:1000], "finishedAt": now_ms(), "leaseExpiresAt": None})
            except Exception as publish_error:
                LOG.exception("Could not publish failure for job %s", job_id)
                self._record_app_error(str((job or {}).get("action") or "unknown_job"), publish_error, source="worker.job.publish_failure", job=job)
            try:
                reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
            except Exception as queue_error:
                LOG.exception("Could not remove queue item for failed job %s", job_id)
                self._record_app_error(str((job or {}).get("action") or "unknown_job"), queue_error, source="worker.queue.cleanup", job=job)
        finally:
            renewal_stop.set()
            if job:
                try:
                    self._release_repository_lock(job)
                except Exception as lock_error:
                    LOG.exception("Could not release repository lock for job %s", job_id)
                    self._record_app_error(str(job.get("action") or "unknown_job"), lock_error, source="worker.lock.release", job=job)
            with self.lock:
                self.active.discard(job_id)
            try:
                self._heartbeat()
            except Exception as heartbeat_error:
                LOG.exception("Post-job heartbeat failed")
                self._record_app_error(str((job or {}).get("action") or "heartbeat"), heartbeat_error, source="worker.post_job_heartbeat", job=job)
            self.wake_event.set()


def main() -> None:
    settings = Settings.from_environment()
    initialize(settings.firebase_database_url, settings.service_account_json)
    worker = Worker(settings)
    for selected_signal in (signal.SIGTERM, signal.SIGINT):
        signal.signal(selected_signal, lambda *_args: worker.request_stop())
    try:
        worker.start()
    finally:
        worker.stop()


if __name__ == "__main__":
    main()
