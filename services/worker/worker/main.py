from __future__ import annotations

import concurrent.futures
import logging
import os
import platform
import signal
import sys
import threading
import time
import traceback

from worker.config import Settings
from worker.core import docker_ops
from worker.executor import container_inventory, execute, execute_container, execute_container_command, execute_worker_command
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
        "worker_command": "run worker command",
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
            "traefikEnabled": self.settings.traefik_enabled,
            "traefikNetwork": self.settings.traefik_network,
            "leaseSeconds": self.settings.lease_seconds,
            "pollSeconds": self.settings.poll_seconds,
            "docker": self._docker_summary(),
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
        self._heartbeat()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        for shard in self.settings.shards:
            self.listeners.append(reference(f"queues/{self.settings.pool_id}/{shard}").listen(lambda _event: self.wake_event.set()))
        LOG.info("Worker %s (%s) listening on pool=%s shards=%s", self.settings.worker_id, self.worker_label or "unnamed", self.settings.pool_id, ",".join(self.settings.shards))
        while not self.stop_event.is_set():
            try:
                self.scan()
            except Exception:
                LOG.exception("Worker scan failed")
            finally:
                self.wake_event.wait(self.settings.poll_seconds)
                self.wake_event.clear()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        for listener in self.listeners:
            try:
                listener.close()
            except Exception:
                LOG.exception("Could not close Firebase listener")
        self.pool.shutdown(wait=True, cancel_futures=False)
        try:
            self._heartbeat("offline")
        except Exception:
            LOG.exception("Could not mark worker offline")

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
        except Exception:
            LOG.exception("Could not mark worker stopping")

    def _heartbeat(self, status: str = "online") -> None:
        with self.lock:
            active_jobs = len(self.active)
        payload = self._worker_payload(status, active_jobs)
        if status == "stopping":
            payload["stoppingAt"] = now_ms()
        reference(f"workspaces/{self.settings.workspace_id}/agents/{self.settings.worker_id}").set(payload)
        if status == "online":
            try:
                self._publish_container_inventory(self.settings.workspace_id)
            except Exception:
                LOG.exception("Container inventory failed")

    def _publish_container_inventory(self, workspace_id: str) -> None:
        inventory = container_inventory()
        existing = reference(f"workspaces/{workspace_id}/containers").get() or {}
        updates = {}
        seen_record_ids = set()
        now = now_ms()
        for docker_id, item in inventory.items():
            record_id = container_record_id(self.settings.worker_id, item.get("name", docker_id))
            previous = existing.get(record_id) or existing.get(docker_id) or {}
            seen_record_ids.add(record_id)
            updated = {
                **previous,
                **item,
                "id": record_id,
                "dockerId": docker_id,
                "workerId": self.settings.worker_id,
                "workerLabel": self.worker_label,
                "workerHostname": self.settings.hostname,
                "poolId": self.settings.pool_id,
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
            if item.get("workerId") == self.settings.worker_id and container_id not in seen_record_ids and container_id not in inventory:
                updates[f"workspaces/{workspace_id}/containers/{container_id}"] = None
                LOG.info("Removing stale container record %s for worker %s", container_id, self.settings.worker_id)
        if updates:
            reference().update(updates)

    def _heartbeat_loop(self) -> None:
        while not self.stop_event.wait(10):
            try:
                self._heartbeat()
            except Exception:
                LOG.exception("Heartbeat failed")

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
                except Exception:
                    LOG.exception("Lease renewal failed for job %s", job_id)
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
            elif job["action"].startswith("container_"):
                LOG.info("Job %s running: %s on %s", job_id, job_action_label(job["action"]), job_subject(job))
                message, log_tail = execute_container(job)
                if log_tail is not None:
                    reference(f"workspaces/{job['workspaceId']}/containers/{job['containerId']}/logTail").set(log_tail)
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
            try:
                job = reference(f"jobs/{job_id}").get() or job or {"id": job_id, "workspaceId": self.settings.workspace_id}
                self._publish(job, {"status": "failed", "message": str(error)[:1000], "finishedAt": now_ms(), "leaseExpiresAt": None})
            except Exception:
                LOG.exception("Could not publish failure for job %s", job_id)
            try:
                reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
            except Exception:
                LOG.exception("Could not remove queue item for failed job %s", job_id)
        finally:
            renewal_stop.set()
            if job:
                try:
                    self._release_repository_lock(job)
                except Exception:
                    LOG.exception("Could not release repository lock for job %s", job_id)
            with self.lock:
                self.active.discard(job_id)
            try:
                self._heartbeat()
            except Exception:
                LOG.exception("Post-job heartbeat failed")
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
