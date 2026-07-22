from __future__ import annotations

import json
import os
import re
import time
import uuid

import firebase_admin
from fastapi import FastAPI, Header, HTTPException
from firebase_admin import credentials, db
from pydantic import BaseModel, Field

from src.crew import run_diagnostics
from src.github_services import GitHubServices

app = FastAPI(title="Docker Panel Logs CrewAI Agent", version="1.0.0")


class AgentRequest(BaseModel):
    logs: list[dict] = Field(min_length=1, max_length=50)
    instruction: str = Field(default="", max_length=2000)
    format: str = "markdown"
    apply: bool = False
    hotfix: bool = False
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""


class HistoryRequest(BaseModel):
    runId: str = Field(min_length=1, max_length=80)
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""
    report: str = Field(min_length=1, max_length=10000)
    kind: str = "analysis"


def firebase_app():
    if firebase_admin._apps:
        return firebase_admin.get_app()
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    credential = credentials.Certificate(json.loads(raw)) if raw else credentials.ApplicationDefault()
    return firebase_admin.initialize_app(credential, {"databaseURL": os.environ.get("FIREBASE_DATABASE_URL") or os.environ.get("NEXT_PUBLIC_FIREBASE_DATABASE_URL")})


def mark_logs_analyzed(workspace_id: str, logs: list[dict], requested_by: str) -> None:
    reviewed_at = int(time.time() * 1000)
    for log in logs:
        log_id = str(log.get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", log_id):
            continue
        reference = db.reference(f"workspaces/{workspace_id}/app_logs/{log_id}", app=firebase_app())

        def increment(current):
            if not isinstance(current, dict):
                return current
            current["analyzed"] = True
            current["analysisCount"] = max(0, int(current.get("analysisCount") or 0)) + 1
            current["lastAnalyzedAt"] = reviewed_at
            current["lastAnalyzedBy"] = requested_by
            return current

        reference.transaction(increment)


@app.get("/health")
def health():
    return {"ok": True, "service": "logs-agent"}


@app.post("/v1/diagnose")
def diagnose(request: AgentRequest, x_agent_secret: str = Header(default="")):
    expected = os.environ.get("LOGS_AGENT_SECRET", "")
    if not expected or x_agent_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid agent service credential")
    run_id = uuid.uuid4().hex[:16]
    trace = db.reference(f"workspaces/{request.workspaceId}/agent_runs/{run_id}", app=firebase_app())
    if request.hotfix and not request.apply:
        raise HTTPException(status_code=400, detail="Hotfix requires apply mode")
    trace.set({"id": run_id, "status": "running", "requestedBy": request.requestedBy, "requestedByEmail": request.requestedByEmail, "apply": request.apply, "hotfix": request.hotfix, "format": request.format, "logIds": [str(log.get("id", "")) for log in request.logs], "createdAt": {".sv": "timestamp"}})
    try:
        github = GitHubServices(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_BASE_BRANCH", "main"), run_id, request.apply, request.hotfix)
        report = run_diagnostics(logs=request.logs, instruction=request.instruction, markdown=request.format == "markdown", github=github)
        if request.apply:
            source_changes = [change for change in github.changes if change.get("path", "").startswith("services/")]
            if not source_changes:
                raise RuntimeError("Fix was not applied: the agent did not modify any services/** source file")
            github.append_changelog(status="applied", summary=report, requested_by=request.requestedByEmail or request.requestedBy)
        mark_logs_analyzed(request.workspaceId, request.logs, request.requestedBy)
        result = {"runId": run_id, "report": report, "branch": github.branch, "changes": github.changes, "format": request.format, "hotfix": request.hotfix}
        trace.update({**result, "status": "completed", "finishedAt": {".sv": "timestamp"}})
        return result
    except Exception as error:
        message = re.sub(r"(token|authorization|key)=?[^\s,]+", r"\1=[REDACTED]", str(error), flags=re.I)[:2000]
        trace.update({"status": "failed", "error": message, "finishedAt": {".sv": "timestamp"}})
        raise HTTPException(status_code=500, detail=message) from error


@app.post("/v1/history")
def save_history(request: HistoryRequest, x_agent_secret: str = Header(default="")):
    expected = os.environ.get("LOGS_AGENT_SECRET", "")
    if not expected or x_agent_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid agent service credential")
    trace = db.reference(f"workspaces/{request.workspaceId}/agent_runs/{request.runId}", app=firebase_app())
    if request.kind == "analysis":
        trace.update({"saved": True, "savedAt": {".sv": "timestamp"}})
        return {"ok": True, "runId": request.runId, "saved": "firebase"}
    if request.kind != "solution":
        raise HTTPException(status_code=400, detail="kind must be analysis or solution")
    try:
        existing = trace.get() or {}
        if existing.get("solutionStatus") == "proposed" and existing.get("branch"):
            return {"ok": True, "runId": request.runId, "saved": "firebase+changelog", "branch": existing["branch"], "change": existing.get("historyChange", {})}
        github = GitHubServices(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_BASE_BRANCH", "main"), request.runId, True)
        change = github.append_changelog(status="proposed", summary=request.report, requested_by=request.requestedByEmail or request.requestedBy)
        trace.update({"saved": True, "solutionStatus": "proposed", "solutionReport": request.report, "branch": github.branch, "historyChange": change, "savedAt": {".sv": "timestamp"}})
        return {"ok": True, "runId": request.runId, "saved": "firebase+changelog", "branch": github.branch, "change": change}
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)[:2000]) from error
