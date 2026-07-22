from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path


class FixStore:
    """Persistent, agent-owned audit store for fixes that reached Git."""

    def __init__(self, path: str | None = None) -> None:
        self.path = Path(path or os.environ.get("LOGS_AGENT_DATABASE_PATH", "/data/logs-agent.db"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS fixes (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
                    run_id TEXT NOT NULL UNIQUE, repository TEXT NOT NULL,
                    base_branch TEXT NOT NULL, target_branch TEXT NOT NULL,
                    commit_sha TEXT NOT NULL, commit_message TEXT NOT NULL,
                    hotfix INTEGER NOT NULL, requested_by TEXT NOT NULL,
                    requested_by_email TEXT NOT NULL, report TEXT NOT NULL,
                    changes_json TEXT NOT NULL, log_ids_json TEXT NOT NULL,
                    patches_json TEXT NOT NULL DEFAULT '[]',
                    created_at INTEGER NOT NULL
                )
            """)
            connection.execute("CREATE INDEX IF NOT EXISTS fixes_workspace_created ON fixes(workspace_id, created_at DESC)")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(fixes)").fetchall()}
            if "patches_json" not in columns:
                connection.execute("ALTER TABLE fixes ADD COLUMN patches_json TEXT NOT NULL DEFAULT '[]'")

    def save(self, *, fix_id: str, workspace_id: str, run_id: str, repository: str,
             base_branch: str, target_branch: str, commit_sha: str,
             commit_message: str, hotfix: bool, requested_by: str,
             requested_by_email: str, report: str, changes: list[dict],
             log_ids: list[str], patches: list[dict] | None = None) -> dict:
        values = (
            fix_id, workspace_id, run_id, repository, base_branch, target_branch,
            commit_sha, commit_message, int(hotfix), requested_by,
            requested_by_email, report[:10_000], json.dumps(changes),
            json.dumps(log_ids), json.dumps(patches or []), int(time.time() * 1000),
        )
        with self._lock, self._connect() as connection:
            connection.execute("""
                INSERT INTO fixes (
                    id, workspace_id, run_id, repository, base_branch, target_branch,
                    commit_sha, commit_message, hotfix, requested_by,
                    requested_by_email, report, changes_json, log_ids_json,
                    patches_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    target_branch=excluded.target_branch, commit_sha=excluded.commit_sha,
                    commit_message=excluded.commit_message,
                    changes_json=excluded.changes_json, log_ids_json=excluded.log_ids_json,
                    patches_json=excluded.patches_json
            """, values)
        return self.get(workspace_id, fix_id) or {}

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        value = dict(row)
        patches = json.loads(value.get("patches_json") or "[]")
        return {
            "id": value["id"], "workspaceId": value["workspace_id"],
            "runId": value["run_id"], "repository": value["repository"],
            "baseBranch": value["base_branch"], "targetBranch": value["target_branch"],
            "commitSha": value["commit_sha"], "commitMessage": value["commit_message"],
            "hotfix": bool(value["hotfix"]), "requestedBy": value["requested_by"],
            "requestedByEmail": value["requested_by_email"], "report": value["report"],
            "changes": json.loads(value["changes_json"]),
            "logIds": json.loads(value["log_ids_json"]), "createdAt": value["created_at"],
            "reapplicable": bool(patches) and all("previousContent" in patch and "content" in patch for patch in patches),
        }

    def get(self, workspace_id: str, fix_id: str) -> dict | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM fixes WHERE workspace_id = ? AND id = ?", (workspace_id, fix_id)).fetchone()
        return self._record(row) if row else None

    def list(self, workspace_id: str, limit: int = 200) -> list[dict]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM fixes WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
                (workspace_id, min(500, max(1, limit))),
            ).fetchall()
        return [self._record(row) for row in rows]

    def reapply_payload(self, workspace_id: str, fix_id: str) -> tuple[dict, list[dict]] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM fixes WHERE workspace_id = ? AND id = ?", (workspace_id, fix_id)).fetchone()
        if not row:
            return None
        return self._record(row), json.loads(row["patches_json"] or "[]")
