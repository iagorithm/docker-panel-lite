from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field

import requests
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
    branch: str = ""
    changes: list[dict[str, str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise ValueError("GITHUB_REPOSITORY must use owner/repository format")
        self.api = f"https://api.github.com/repos/{self.repository}"
        self.headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {self.token}", "X-GitHub-Api-Version": "2022-11-28"}

    def request(self, method: str, path: str, **kwargs):
        response = requests.request(method, f"{self.api}{path}", headers=self.headers, timeout=30, **kwargs)
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
        return content

    def ensure_branch(self) -> str:
        if self.branch:
            return self.branch
        base = self.request("GET", f"/git/ref/heads/{self.base_branch}")
        self.branch = f"logs-agent/{self.run_id}"
        self.request("POST", "/git/refs", json={"ref": f"refs/heads/{self.branch}", "sha": base["object"]["sha"]})
        return self.branch

    def write_file(self, path: str, content: str, reason: str) -> str:
        if not self.allow_writes:
            return "WRITE BLOCKED: analysis-only run. Recommend the change in the report."
        safe = self.safe_path(path)
        if len(content.encode("utf-8")) > 300_000:
            raise ValueError("Agent writes are limited to 300 KB per file")
        branch = self.ensure_branch()
        current = self.request("GET", f"/contents/{safe}?ref={branch}")
        result = self.request("PUT", f"/contents/{safe}", json={"message": f"fix(services): {reason[:120]}", "content": base64.b64encode(content.encode()).decode(), "sha": current["sha"], "branch": branch})
        change = {"path": safe, "commit": result["commit"]["sha"], "reason": reason[:500]}
        self.changes.append(change)
        return f"Updated {safe} on {branch} in commit {change['commit']}"


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
    description: str = "Replace an existing services/** file on a dedicated branch when apply mode is enabled."
    args_schema: type[BaseModel] = WriteInput
    backend: GitHubServices

    def _run(self, path: str, content: str, reason: str) -> str:
        return self.backend.write_file(path, content, reason)
