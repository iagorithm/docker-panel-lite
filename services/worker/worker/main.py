from __future__ import annotations

import concurrent.futures
import logging
import signal
import threading
import time
import traceback

from worker.config import Settings
from worker.executor import container_inventory, execute, execute_container
from worker.firebase_runtime import initialize, reference

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("deployment-worker")


def now_ms() -> int:
    return int(time.time() * 1000)


class Worker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.active: set[str] = set()
        self.lock = threading.Lock()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=settings.max_concurrency, thread_name_prefix="job")
        self.listeners = []

    def start(self) -> None:
        self._heartbeat()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        for shard in self.settings.shards:
            self.listeners.append(reference(f"queues/{self.settings.pool_id}/{shard}").listen(lambda _event: self.wake_event.set()))
        LOG.info("Worker %s listening on pool=%s shards=%s", self.settings.worker_id, self.settings.pool_id, ",".join(self.settings.shards))
        while not self.stop_event.is_set():
            self.scan()
            self.wake_event.wait(self.settings.poll_seconds)
            self.wake_event.clear()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        for listener in self.listeners:
            listener.close()
        self.pool.shutdown(wait=True, cancel_futures=False)
        self._heartbeat("offline")

    def _heartbeat(self, status: str = "online") -> None:
        with self.lock:
            active_jobs = len(self.active)
        reference(f"workspaces/{self.settings.workspace_id}/agents/{self.settings.worker_id}").set({
            "id": self.settings.worker_id, "hostname": self.settings.hostname, "poolId": self.settings.pool_id,
            "status": status, "activeJobs": active_jobs, "maxConcurrency": self.settings.max_concurrency,
            "shards": list(self.settings.shards), "lastHeartbeat": now_ms(),
        })
        if status == "online":
            try:
                self._publish_container_inventory(self.settings.workspace_id)
            except Exception:
                LOG.exception("Container inventory failed")

    def _publish_container_inventory(self, workspace_id: str) -> None:
        inventory = container_inventory()
        existing = reference(f"workspaces/{workspace_id}/containers").get() or {}
        for container_id, item in inventory.items():
            if existing.get(container_id, {}).get("logTail"):
                item["logTail"] = existing[container_id]["logTail"]
        reference(f"workspaces/{workspace_id}/containers").set(inventory)

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
            for job_id in sorted(queued, key=lambda item: queued[item].get("createdAt", 0)):
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
            lease_expired = int(job.get("leaseExpiresAt", 0)) < timestamp
            if job.get("status") not in {"queued", "leased", "running"} or (job.get("workerId") and not lease_expired):
                return job
            if job.get("cancellationRequested"):
                return {**job, "status": "cancelled", "finishedAt": timestamp, "message": "Cancelled before execution"}
            return {**job, "status": "leased", "workerId": self.settings.worker_id, "leaseExpiresAt": timestamp + self.settings.lease_seconds * 1000, "attempt": int(job.get("attempt", 0)) + 1, "startedAt": job.get("startedAt", timestamp)}
        claimed = reference(f"jobs/{job_id}").transaction(update)
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
        lock_ref.transaction(lambda current: None if current and current.get("jobId") == job["id"] else current)

    def _process(self, job_id: str, shard: str) -> None:
        renewal_stop = threading.Event()
        try:
            job = self._claim(job_id)
            if not job:
                current = reference(f"jobs/{job_id}").get() or {}
                if current.get("status") in {"completed", "failed", "cancelled"}:
                    reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
                return
            if job["workspaceId"] != self.settings.workspace_id:
                raise PermissionError("Worker is not assigned to this workspace")
            if not self._acquire_repository_lock(job):
                self._publish(job, {"status": "queued", "workerId": None, "leaseExpiresAt": None, "message": "Waiting for repository lock"})
                return
            self._publish(job, {"status": "running", "progress": 10, "message": "Worker claimed deployment"})
            def renew():
                while not renewal_stop.wait(max(10, self.settings.lease_seconds // 3)):
                    current = reference(f"jobs/{job_id}").get() or {}
                    if current.get("workerId") != self.settings.worker_id or current.get("cancellationRequested"):
                        return
                    self._publish(job, {"leaseExpiresAt": now_ms() + self.settings.lease_seconds * 1000})
                    lock_key = job.get("repositoryId") or f"container-{job.get('containerId', 'unknown')}"
                    reference(f"locks/{job['workspaceId']}/{lock_key}/expiresAt").set(now_ms() + self.settings.lease_seconds * 1000)
            threading.Thread(target=renew, daemon=True).start()
            self._publish(job, {"progress": 25, "message": f"Executing {job['action']}"})
            if job["action"] == "inventory_refresh":
                self._publish_container_inventory(job["workspaceId"])
                message = "Container inventory refreshed"
            elif job["action"].startswith("container_"):
                message, log_tail = execute_container(job)
                if log_tail is not None:
                    reference(f"workspaces/{job['workspaceId']}/containers/{job['containerId']}/logTail").set(log_tail)
            else:
                repository_ref = reference(f"workspaces/{job['workspaceId']}/repositories/{job['repositoryId']}")
                repository = repository_ref.get()
                if not repository:
                    raise ValueError("Repository no longer exists")
                message, repository_updates = execute(job, repository, self.settings)
                if repository_updates:
                    repository_ref.update(repository_updates)
            current = reference(f"jobs/{job_id}").get() or {}
            status = "cancelled" if current.get("cancellationRequested") else "completed"
            self._publish(job, {"status": status, "progress": 100, "message": message, "finishedAt": now_ms(), "leaseExpiresAt": None})
            reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
        except Exception as error:
            LOG.error("Job %s failed: %s\n%s", job_id, error, traceback.format_exc())
            job = reference(f"jobs/{job_id}").get() or {"id": job_id, "workspaceId": self.settings.workspace_id}
            self._publish(job, {"status": "failed", "message": str(error)[:1000], "finishedAt": now_ms(), "leaseExpiresAt": None})
            reference(f"queues/{self.settings.pool_id}/{shard}/{job_id}").delete()
        finally:
            renewal_stop.set()
            if 'job' in locals() and job:
                try:
                    self._release_repository_lock(job)
                except Exception:
                    LOG.exception("Could not release repository lock for job %s", job_id)
            with self.lock:
                self.active.discard(job_id)
            self._heartbeat()
            self.wake_event.set()


def main() -> None:
    settings = Settings.from_environment()
    initialize(settings.firebase_database_url, settings.service_account_json)
    worker = Worker(settings)
    for selected_signal in (signal.SIGTERM, signal.SIGINT):
        signal.signal(selected_signal, lambda *_args: worker.stop_event.set())
    try:
        worker.start()
    finally:
        worker.stop()


if __name__ == "__main__":
    main()
