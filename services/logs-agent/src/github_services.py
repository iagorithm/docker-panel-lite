from __future__ import annotations

import base64
import ast
import difflib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from crewai.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field


class PathInput(BaseModel):
    path: str = Field(description="Repository-relative path inside services/")


class WriteInput(PathInput):
    content: str = Field(description="Complete corrected UTF-8 file content")
    reason: str = Field(description="Concise reason for this correction")


@dataclass
class GitHubServices:
    token: str
    repository: str
    base_branch: str
    run_id: str
    allow_writes: bool
    hotfix: bool = False
    preview_writes: bool = False
    branch: str = ""
    changes: list[dict[str, str]] = field(default_factory=list)
    preview_changes: list[dict[str, str]] = field(default_factory=list)
    read_paths: set[str] = field(default_factory=set)
    session: requests.Session = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise ValueError("GITHUB_REPOSITORY must use owner/repository format")
        self.api = f"https://api.github.com/repos/{self.repository}"
        self.headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {self.token}", "X-GitHub-Api-Version": "2022-11-28"}
        self.session = requests.Session()
        retries = Retry(total=3, connect=3, read=3, backoff_factor=0.4, status_forcelist=(429, 500, 502, 503, 504), allowed_methods=frozenset({"GET", "HEAD", "OPTIONS"}), respect_retry_after_header=True)
        self.session.mount("https://", HTTPAdapter(max_retries=retries, pool_connections=4, pool_maxsize=8))

    def request(self, method: str, path: str, **kwargs):
        response = self.session.request(method, f"{self.api}{path}", headers=self.headers, timeout=(5, 30), **kwargs)
        if response.status_code >= 400:
            try:
                detail = response.json().get("message", response.text[:500])
            except ValueError:
                detail = response.text[:500]
            raise RuntimeError(f"GitHub {method} {path} failed ({response.status_code}): {detail}")
        return response.json() if response.content else {}

    @staticmethod
    def safe_path(path: str) -> str:
        normalized = path.strip().lstrip("/")
        if not normalized.startswith("services/") or ".." in normalized.split("/"):
            raise ValueError("Access is restricted to services/**")
        return normalized

    def list_files(self) -> str:
        tree = self.request("GET", f"/git/trees/{self.base_branch}?recursive=1")
        return "\n".join(item["path"] for item in tree.get("tree", []) if item.get("type") == "blob" and str(item.get("path", "")).startswith("services/"))

    def read_file(self, path: str) -> str:
        safe = self.safe_path(path)
        value = self.request("GET", f"/contents/{safe}?ref={self.branch or self.base_branch}")
        content = base64.b64decode(value["content"]).decode("utf-8")
        if len(content) > 300_000:
            raise ValueError(f"{safe} is larger than the agent read limit")
        self.read_paths.add(safe)
        return content

    def branch_name(self, reason: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", reason.lower()).strip("-")[:48] or "service-error"
        return f"fix/{slug}-{self.run_id[:6]}"

    def ensure_branch(self, reason: str = "") -> str:
        if self.branch:
            return self.branch
        if self.hotfix:
            self.branch = self.base_branch
            return self.branch
        base = self.request("GET", f"/git/ref/heads/{self.base_branch}")
        self.branch = self.branch_name(reason)
        self.request("POST", "/git/refs", json={"ref": f"refs/heads/{self.branch}", "sha": base["object"]["sha"]})
        return self.branch

    def write_file(self, path: str, content: str, reason: str, commit_message: str = "") -> str:
        if not self.allow_writes:
            return "WRITE BLOCKED: analysis-only run. Recommend the change in the report."
        safe = self.safe_path(path)
        if safe not in self.read_paths:
            return f"WRITE BLOCKED: read the complete current {safe} with read_services_file before proposing a change."
        recorded_changes = [*self.changes, *self.preview_changes]
        changed_files = {change["path"] for change in recorded_changes if change["path"].startswith("services/")}
        max_files = max(1, int(os.environ.get("LOGS_AGENT_MAX_CHANGED_FILES", "3")))
        if safe not in changed_files and len(changed_files) >= max_files:
            return f"WRITE BLOCKED: a fix may change at most {max_files} services files. Reduce scope and prepare separate fixes."
        if self.hotfix and any(change["path"] != safe and change["path"].startswith("services/") for change in recorded_changes):
            return "WRITE BLOCKED: hotfix mode permits changes to only one services/** file. Use a dedicated branch for a larger correction."
        if len(content.encode("utf-8")) > 300_000:
            raise ValueError("Agent writes are limited to 300 KB per file")
        current = self.request("GET", f"/contents/{safe}?ref={self.branch or self.base_branch}")
        previous = base64.b64decode(current["content"]).decode("utf-8")
        self.validate_safe_replacement(safe, previous, content)
        if self.preview_writes:
            diff = "\n".join(difflib.unified_diff(previous.splitlines(), content.splitlines(), fromfile=f"a/{safe}", tofile=f"b/{safe}", lineterm=""))
            self.preview_changes = [change for change in self.preview_changes if change["path"] != safe]
            self.preview_changes.append({"path": safe, "content": content, "reason": reason[:500], "diff": diff, "baseSha": current["sha"]})
            return f"Preview ready for {safe}; no commit was created"
        branch = self.ensure_branch(reason)
        message = (commit_message.strip() or f"fix(services): {reason}").replace("\n", " ")[:120]
        result = self.request("PUT", f"/contents/{safe}", json={"message": message, "content": base64.b64encode(content.encode()).decode(), "sha": current["sha"], "branch": branch})
        change = {"path": safe, "commit": result["commit"]["sha"], "reason": reason[:500]}
        self.changes.append(change)
        return f"Updated {safe} on {branch} in commit {change['commit']}"

    def commit_preview_batch(self, previews: list[dict], commit_message: str, summary: str, requested_by: str) -> tuple[str, list[dict[str, str]]]:
        if not previews:
            raise ValueError("No preview changes to commit")
        reason = str(previews[0].get("reason") or "service error")
        target_branch = self.base_branch if self.hotfix else self.branch_name(reason)
        base_ref = self.request("GET", f"/git/ref/heads/{self.base_branch}")
        parent_sha = base_ref["object"]["sha"]
        parent_commit = self.request("GET", f"/git/commits/{parent_sha}")
        tree_entries = []
        changed_paths = []
        for preview in previews:
            safe = self.safe_path(str(preview.get("path") or ""))
            current = self.request("GET", f"/contents/{safe}?ref={self.base_branch}")
            if current.get("sha") != preview.get("baseSha"):
                raise RuntimeError(f"Stale preview blocked: {safe} changed after review; prepare the fix again")
            previous = base64.b64decode(current["content"]).decode("utf-8")
            proposed = str(preview.get("content") or "")
            self.validate_safe_replacement(safe, previous, proposed)
            blob = self.request("POST", "/git/blobs", json={"content": proposed, "encoding": "utf-8"})
            tree_entries.append({"path": safe, "mode": "100644", "type": "blob", "sha": blob["sha"]})
            changed_paths.append((safe, str(preview.get("reason") or reason)[:500]))

        changelog_path = "CHANGELOGS.md"
        response = self.session.get(f"{self.api}/contents/{changelog_path}", headers=self.headers, params={"ref": self.base_branch}, timeout=(5, 30))
        if response.status_code == 404:
            changelog = "# Correction history\n"
        elif response.status_code >= 400:
            raise RuntimeError(f"GitHub GET {changelog_path} failed ({response.status_code}): {response.text[:500]}")
        else:
            changelog = base64.b64decode(response.json()["content"]).decode("utf-8")
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        delivery = "hotfix" if self.hotfix else "branch"
        entry = f"\n## {timestamp} · applied\n\n- Run: `{self.run_id}`\n- Requested by: `{requested_by or 'unknown'}`\n- Branch: `{target_branch}`\n- Delivery: `{delivery}`\n\n{summary.strip()[:4000]}\n"
        changelog_blob = self.request("POST", "/git/blobs", json={"content": changelog.rstrip() + "\n" + entry, "encoding": "utf-8"})
        tree_entries.append({"path": changelog_path, "mode": "100644", "type": "blob", "sha": changelog_blob["sha"]})
        tree = self.request("POST", "/git/trees", json={"base_tree": parent_commit["tree"]["sha"], "tree": tree_entries})
        message = commit_message.strip().replace("\n", " ")[:120]
        commit = self.request("POST", "/git/commits", json={"message": message, "tree": tree["sha"], "parents": [parent_sha]})
        if self.hotfix:
            self.request("PATCH", f"/git/refs/heads/{self.base_branch}", json={"sha": commit["sha"], "force": False})
        else:
            self.request("POST", "/git/refs", json={"ref": f"refs/heads/{target_branch}", "sha": commit["sha"]})
        self.branch = target_branch
        self.changes = [{"path": path, "commit": commit["sha"], "reason": item_reason} for path, item_reason in changed_paths]
        self.changes.append({"path": changelog_path, "commit": commit["sha"], "reason": "Record applied correction"})
        return target_branch, self.changes

    @staticmethod
    def validate_safe_replacement(path: str, previous: str, proposed: str) -> None:
        if not proposed.strip():
            raise ValueError("Destructive fix blocked: proposed file is empty")
        if proposed == previous:
            raise ValueError("No-op fix blocked: proposed file is identical to the current code")
        if len(proposed.encode("utf-8")) < len(previous.encode("utf-8")) * 0.9:
            raise ValueError("Destructive fix blocked: proposed file removes more than 10% of the existing code")
        diff = difflib.ndiff(previous.splitlines(), proposed.splitlines())
        removed = sum(1 for line in diff if line.startswith("- ") and line[2:].strip())
        existing_lines = max(1, sum(1 for line in previous.splitlines() if line.strip()))
        removal_limit = min(20, max(3, int(existing_lines * 0.1)))
        if removed > removal_limit:
            raise ValueError(f"Destructive fix blocked: proposed change removes {removed} existing lines")
        if path.endswith(".py"):
            try:
                ast.parse(proposed, filename=path)
            except SyntaxError as error:
                raise ValueError(f"Invalid Python fix blocked: {error.msg} at line {error.lineno}") from error
        if path.endswith(".json"):
            try:
                json.loads(proposed)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSON fix blocked: {error.msg} at line {error.lineno}") from error

    def append_changelog(self, *, status: str, summary: str, requested_by: str) -> dict[str, str]:
        branch = self.ensure_branch()
        path = "CHANGELOGS.md"
        response = self.session.get(f"{self.api}/contents/{path}", headers=self.headers, params={"ref": branch}, timeout=(5, 30))
        if response.status_code == 404:
            current = None
            content = "# Correction history\n"
        elif response.status_code >= 400:
            raise RuntimeError(f"GitHub GET {path} failed ({response.status_code}): {response.text[:500]}")
        else:
            current = response.json()
            content = base64.b64decode(current["content"]).decode("utf-8")
        timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        concise = summary.strip()[:4000]
        delivery = "hotfix" if self.hotfix else "branch"
        entry = f"\n## {timestamp} · {status}\n\n- Run: `{self.run_id}`\n- Requested by: `{requested_by or 'unknown'}`\n- Branch: `{branch}`\n- Delivery: `{delivery}`\n\n{concise}\n"
        payload = {
            "message": f"docs: record logs-agent {status}",
            "content": base64.b64encode((content.rstrip() + "\n" + entry).encode()).decode(),
            "branch": branch,
        }
        if current:
            payload["sha"] = current["sha"]
        result = self.request("PUT", f"/contents/{path}", json=payload)
        change = {"path": path, "commit": result["commit"]["sha"], "reason": f"Record {status} correction"}
        self.changes.append(change)
        return change


class ListServicesFilesTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str = "list_services_files"
    description: str = "List source files under services/."
    backend: GitHubServices

    def _run(self) -> str:
        return self.backend.list_files()


class ReadServicesFileTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str = "read_services_file"
    description: str = "Read one source file under services/."
    args_schema: type[BaseModel] = PathInput
    backend: GitHubServices

    def _run(self, path: str) -> str:
        return self.backend.read_file(path)


class WriteServicesFileTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    name: str = "write_services_file"
    description: str = "Replace an existing services/** file when apply mode is enabled. Hotfix mode is restricted to one services file on the base branch."
    args_schema: type[BaseModel] = WriteInput
    backend: GitHubServices

    def _run(self, path: str, content: str, reason: str) -> str:
        return self.backend.write_file(path, content, reason)
