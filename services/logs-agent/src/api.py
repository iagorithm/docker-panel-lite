from __future__ import annotations

import json
import os
import re
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
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""


def firebase_app():
    if firebase_admin._apps:
        return firebase_admin.get_app()
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    credential = credentials.Certificate(json.loads(raw)) if raw else credentials.ApplicationDefault()
    return firebase_admin.initialize_app(credential, {"databaseURL": os.environ.get("FIREBASE_DATABASE_URL") or os.environ.get("NEXT_PUBLIC_FIREBASE_DATABASE_URL")})


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
    trace.set({"id": run_id, "status": "running", "requestedBy": request.requestedBy, "requestedByEmail": request.requestedByEmail, "apply": request.apply, "format": request.format, "logIds": [str(log.get("id", "")) for log in request.logs], "createdAt": {".sv": "timestamp"}})
    try:
        github = GitHubServices(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_BASE_BRANCH", "main"), run_id, request.apply)
        report = run_diagnostics(logs=request.logs, instruction=request.instruction, markdown=request.format == "markdown", github=github)
        result = {"runId": run_id, "report": report, "branch": github.branch, "changes": github.changes, "format": request.format}
        trace.update({**result, "status": "completed", "finishedAt": {".sv": "timestamp"}})
        return result
    except Exception as error:
        message = re.sub(r"(token|authorization|key)=?[^\s,]+", r"\1=[REDACTED]", str(error), flags=re.I)[:2000]
        trace.update({"status": "failed", "error": message, "finishedAt": {".sv": "timestamp"}})
        raise HTTPException(status_code=500, detail=message) from error
