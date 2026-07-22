from __future__ import annotations

import base64
import difflib
import json
import hmac
import os
import re
import threading
import time
import uuid
from typing import Literal

import firebase_admin
from fastapi import FastAPI, Header, HTTPException
from firebase_admin import credentials, db
from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.crew import run_diagnostics
from src.fix_store import FixStore
from src.github_services import GitHubServices

app = FastAPI(title="Docker Panel Logs CrewAI Agent", version="1.0.0")
diagnostic_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("LOGS_AGENT_MAX_CONCURRENCY", "2"))))
PREVIEW_TTL_SECONDS = max(300, int(os.environ.get("LOGS_AGENT_PREVIEW_TTL_SECONDS", "3600")))
fix_store = FixStore()


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    logs: list[dict] = Field(min_length=1, max_length=50)
    instruction: str = Field(default="", max_length=10000)
    format: Literal["markdown", "summary"] = "markdown"
    apply: bool = False
    hotfix: bool = False
    preview: bool = False
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""

    @model_validator(mode="after")
    def validate_payload_size(self):
        maximum = max(50_000, int(os.environ.get("LOGS_AGENT_MAX_PAYLOAD_BYTES", "250000")))
        if len(json.dumps(self.logs, ensure_ascii=False).encode("utf-8")) > maximum:
            raise ValueError(f"logs payload exceeds {maximum} bytes")
        return self


class HistoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runId: str = Field(min_length=1, max_length=80)
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""
    report: str = Field(min_length=1, max_length=10000)
    kind: Literal["analysis", "solution"] = "analysis"


class CommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runId: str = Field(min_length=1, max_length=80)
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""
    hotfix: bool = False
    commitMessage: str = Field(min_length=3, max_length=120)

    @model_validator(mode="after")
    def validate_commit_message(self):
        self.commitMessage = " ".join(self.commitMessage.split())
        if len(self.commitMessage) < 3:
            raise ValueError("commitMessage must contain at least 3 visible characters")
        return self


class ReapplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fixId: str = Field(min_length=5, max_length=100)
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""
    hotfix: bool = False


class FixFromAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    analysisRunId: str = Field(min_length=1, max_length=80)
    instruction: str = Field(default="", max_length=2000)
    format: Literal["markdown", "summary"] = "markdown"
    workspaceId: str
    requestedBy: str
    requestedByEmail: str = ""


def firebase_app():
    if firebase_admin._apps:
        return firebase_admin.get_app()
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    credential = credentials.Certificate(json.loads(raw)) if raw else credentials.ApplicationDefault()
    return firebase_admin.initialize_app(credential, {"databaseURL": os.environ.get("FIREBASE_DATABASE_URL") or os.environ.get("NEXT_PUBLIC_FIREBASE_DATABASE_URL")})


def authorize(secret: str) -> None:
    expected = os.environ.get("LOGS_AGENT_SECRET", "")
    if not expected or not hmac.compare_digest(secret, expected):
        raise HTTPException(status_code=401, detail="Invalid agent service credential")


def validate_segment(value: str, label: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise HTTPException(status_code=400, detail=f"Invalid {label}")


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


def mark_logs_fixed(workspace_id: str, log_ids: list[str], requested_by: str, fix_id: str, run_id: str, branch: str, changes: list[dict], commit_message: str) -> None:
    fixed_at = int(time.time() * 1000)
    commits = [str(change.get("commit", "")) for change in changes if change.get("commit")]
    updates = {}
    for log_id in log_ids:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", str(log_id)):
            continue
        path = f"workspaces/{workspace_id}/app_logs/{log_id}"
        updates.update({
            f"{path}/fixed": True,
            f"{path}/fixedAt": fixed_at,
            f"{path}/fixedBy": requested_by,
            f"{path}/agentFixId": fix_id,
            f"{path}/fixRunId": run_id,
            f"{path}/fixBranch": branch,
            f"{path}/fixCommits": commits,
            f"{path}/fixCommitMessage": commit_message,
        })
    if updates:
        db.reference("/", app=firebase_app()).update(updates)


@app.get("/health")
def health():
    return {"ok": True, "service": "logs-agent"}


@app.get("/ready")
def ready():
    required = ["OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "LOGS_AGENT_SECRET"]
    missing = [name for name in required if not os.environ.get(name, "").strip()]
    if not (os.environ.get("FIREBASE_DATABASE_URL") or os.environ.get("NEXT_PUBLIC_FIREBASE_DATABASE_URL")):
        missing.append("FIREBASE_DATABASE_URL")
    if missing:
        raise HTTPException(status_code=503, detail=f"Missing configuration: {', '.join(missing)}")
    return {"ok": True, "service": "logs-agent", "model": os.environ.get("CREWAI_MODEL", "openai/gpt-5-mini"), "maxConcurrency": int(os.environ.get("LOGS_AGENT_MAX_CONCURRENCY", "2"))}


@app.get("/v1/fixes")
def fixes(workspaceId: str, fixId: str = "", limit: int = 200, x_agent_secret: str = Header(default="")):
    authorize(x_agent_secret)
    validate_segment(workspaceId, "workspaceId")
    if fixId:
        validate_segment(fixId, "fixId")
        record = fix_store.get(workspaceId, fixId)
        if not record:
            raise HTTPException(status_code=404, detail="Agent fix record not found")
        return {"fix": record}
    return {"fixes": fix_store.list(workspaceId, limit)}


@app.post("/v1/fixes/reapply")
def reapply_fix(request: ReapplyRequest, x_agent_secret: str = Header(default="")):
    authorize(x_agent_secret)
    validate_segment(request.workspaceId, "workspaceId")
    validate_segment(request.requestedBy, "requestedBy")
    validate_segment(request.fixId, "fixId")
    stored = fix_store.reapply_payload(request.workspaceId, request.fixId)
    if not stored:
        raise HTTPException(status_code=404, detail="Agent fix record not found")
    original, patches = stored
    configured_repository = os.environ["GITHUB_REPOSITORY"]
    configured_base = os.environ.get("GITHUB_BASE_BRANCH", "main")
    if original["repository"] != configured_repository or original["baseBranch"] != configured_base:
        raise HTTPException(status_code=409, detail="Safe reapply blocked: the configured repository or base branch differs from the original fix")
    if not patches:
        raise HTTPException(status_code=409, detail="This legacy fix does not contain a safe reapply snapshot")
    if request.hotfix and len(patches) != 1:
        raise HTTPException(status_code=400, detail="Hotfix reapply requires exactly one services file")
    run_id = uuid.uuid4().hex[:16]
    github = GitHubServices(os.environ["GITHUB_TOKEN"], configured_repository, configured_base, run_id, True, request.hotfix, True)
    previews = []
    for patch in patches:
        path = github.safe_path(str(patch.get("path") or ""))
        current = github.request("GET", f"/contents/{path}?ref={github.base_branch}")
        current_content = base64.b64decode(current["content"]).decode("utf-8")
        previous = str(patch.get("previousContent") or "")
        proposed = str(patch.get("content") or "")
        if current_content == proposed:
            raise HTTPException(status_code=409, detail=f"Fix is already present in {path}")
        if current_content != previous:
            raise HTTPException(status_code=409, detail=f"Safe reapply blocked: {path} changed since the original fix")
        github.validate_safe_replacement(path, current_content, proposed)
        diff = "\n".join(difflib.unified_diff(current_content.splitlines(), proposed.splitlines(), fromfile=f"a/{path}", tofile=f"b/{path}", lineterm=""))
        previews.append({"path": path, "content": proposed, "previousContent": current_content, "reason": str(patch.get("reason") or original["commitMessage"])[:500], "diff": diff, "baseSha": current["sha"]})
    first_reason = previews[0]["reason"]
    planned_branch = github.base_branch if request.hotfix else github.branch_name(first_reason)
    expires_at = int(time.time() * 1000) + PREVIEW_TTL_SECONDS * 1000
    trace = db.reference(f"workspaces/{request.workspaceId}/agent_runs/{run_id}", app=firebase_app())
    trace.set({
        "id": run_id, "status": "preview", "requestedBy": request.requestedBy,
        "requestedByEmail": request.requestedByEmail, "apply": True,
        "hotfix": request.hotfix, "preview": True, "format": "summary",
        "logIds": original["logIds"], "report": original["report"],
        "baseBranch": github.base_branch, "plannedBranch": planned_branch,
        "commitMessage": original["commitMessage"], "previewChanges": previews,
        "reappliesFixId": request.fixId, "previewExpiresAt": expires_at,
        "createdAt": {".sv": "timestamp"}, "finishedAt": {".sv": "timestamp"},
    })
    public_previews = [{key: patch[key] for key in ("path", "reason", "diff")} for patch in previews]
    return {"runId": run_id, "report": original["report"], "baseBranch": github.base_branch, "plannedBranch": planned_branch, "commitMessage": original["commitMessage"], "previews": public_previews, "hotfix": request.hotfix, "reappliesFixId": request.fixId}


def run_diagnose(request: AgentRequest, x_agent_secret: str, *, mark_review: bool = True):
    authorize(x_agent_secret)
    validate_segment(request.workspaceId, "workspaceId")
    validate_segment(request.requestedBy, "requestedBy")
    if request.hotfix and not request.apply:
        raise HTTPException(status_code=400, detail="Hotfix requires apply mode")
    if not diagnostic_slots.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Agent capacity reached; retry shortly")
    run_id = uuid.uuid4().hex[:16]
    trace = None
    try:
        trace = db.reference(f"workspaces/{request.workspaceId}/agent_runs/{run_id}", app=firebase_app())
        trace.set({"id": run_id, "status": "running", "requestedBy": request.requestedBy, "requestedByEmail": request.requestedByEmail, "apply": request.apply, "hotfix": request.hotfix, "preview": request.preview, "format": request.format, "logIds": [str(log.get("id", "")) for log in request.logs], "createdAt": {".sv": "timestamp"}})
        github = GitHubServices(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_BASE_BRANCH", "main"), run_id, request.apply, request.hotfix, request.preview)
        report = run_diagnostics(logs=request.logs, instruction=request.instruction, markdown=request.format == "markdown", github=github)
        if request.apply:
            source_changes = github.preview_changes if request.preview else [change for change in github.changes if change.get("path", "").startswith("services/")]
            if not source_changes:
                raise RuntimeError("Fix was not applied: the agent did not modify any services/** source file")
            if not request.preview:
                github.append_changelog(status="applied", summary=report, requested_by=request.requestedByEmail or request.requestedBy)
        if mark_review:
            mark_logs_analyzed(request.workspaceId, request.logs, request.requestedBy)
        previews = [{key: change[key] for key in ("path", "reason", "diff")} for change in github.preview_changes]
        first_reason = github.preview_changes[0]["reason"] if github.preview_changes else "service error"
        planned_branch = github.base_branch if request.hotfix else github.branch_name(first_reason)
        commit_message = f"fix(services): {first_reason}"[:120]
        result = {"runId": run_id, "report": report, "branch": github.branch, "baseBranch": github.base_branch, "plannedBranch": planned_branch if request.preview else github.branch, "commitMessage": commit_message if request.preview else "", "changes": github.changes, "previews": previews, "format": request.format, "hotfix": request.hotfix}
        trace_result = {**result, "status": "preview" if request.preview else "completed", "finishedAt": {".sv": "timestamp"}, "previewExpiresAt": int(time.time() * 1000) + PREVIEW_TTL_SECONDS * 1000 if request.preview else None}
        if request.preview:
            trace_result["previewChanges"] = github.preview_changes
        trace.update(trace_result)
        return result
    except Exception as error:
        message = re.sub(r"(token|authorization|key)=?[^\s,]+", r"\1=[REDACTED]", str(error), flags=re.I)[:2000]
        if trace is not None:
            try:
                trace.update({"status": "failed", "error": message, "finishedAt": {".sv": "timestamp"}})
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=message) from error
    finally:
        diagnostic_slots.release()


@app.post("/v1/diagnose")
def diagnose(request: AgentRequest, x_agent_secret: str = Header(default="")):
    """Backward-compatible endpoint; apply/preview flags control its behavior."""
    return run_diagnose(request, x_agent_secret)


@app.post("/v1/analyze")
def analyze(request: AgentRequest, x_agent_secret: str = Header(default="")):
    """Analyze only. No source preview and no Git write are permitted."""
    return run_diagnose(request.model_copy(update={"apply": False, "preview": False, "hotfix": False}), x_agent_secret)


@app.post("/v1/analyze-and-fix")
def analyze_and_fix(request: AgentRequest, x_agent_secret: str = Header(default="")):
    """Analyze and prepare a validated source preview; commit remains separate."""
    return run_diagnose(request.model_copy(update={"apply": True, "preview": True, "hotfix": False}), x_agent_secret)


@app.post("/v1/fix")
def fix_from_analysis(request: FixFromAnalysisRequest, x_agent_secret: str = Header(default="")):
    """Prepare a fix from a completed analysis run without repeating its review count."""
    authorize(x_agent_secret)
    validate_segment(request.workspaceId, "workspaceId")
    validate_segment(request.requestedBy, "requestedBy")
    validate_segment(request.analysisRunId, "analysisRunId")
    analysis = db.reference(f"workspaces/{request.workspaceId}/agent_runs/{request.analysisRunId}", app=firebase_app()).get() or {}
    if analysis.get("requestedBy") != request.requestedBy:
        raise HTTPException(status_code=403, detail="Only the analysis owner can prepare its fix")
    if analysis.get("status") != "completed" or analysis.get("apply") or analysis.get("previewChanges"):
        raise HTTPException(status_code=409, detail="The referenced run is not a completed analysis-only run")
    logs = []
    log_ids = analysis.get("logIds") if isinstance(analysis.get("logIds"), list) else []
    for log_id in log_ids[:50]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", str(log_id)):
            continue
        value = db.reference(f"workspaces/{request.workspaceId}/app_logs/{log_id}", app=firebase_app()).get()
        if isinstance(value, dict):
            logs.append({**value, "id": str(log_id)})
    if not logs:
        raise HTTPException(status_code=409, detail="The analysis logs are no longer available")
    instruction = f"Prepare only the minimal fix supported by this completed analysis. Preserve all unrelated behavior. Analysis: {analysis.get('report', '')}\n{request.instruction}"[:10_000]
    fix_request = AgentRequest(
        logs=logs, instruction=instruction, format=request.format,
        apply=True, preview=True, hotfix=False, workspaceId=request.workspaceId,
        requestedBy=request.requestedBy, requestedByEmail=request.requestedByEmail,
    )
    result = run_diagnose(fix_request, x_agent_secret, mark_review=False)
    db.reference(f"workspaces/{request.workspaceId}/agent_runs/{result['runId']}", app=firebase_app()).update({"sourceAnalysisRunId": request.analysisRunId})
    return {**result, "sourceAnalysisRunId": request.analysisRunId}


@app.post("/v1/commit")
def commit_preview(request: CommitRequest, x_agent_secret: str = Header(default="")):
    authorize(x_agent_secret)
    validate_segment(request.workspaceId, "workspaceId")
    validate_segment(request.requestedBy, "requestedBy")
    trace = db.reference(f"workspaces/{request.workspaceId}/agent_runs/{request.runId}", app=firebase_app())
    existing = trace.get() or {}
    if existing.get("status") != "preview" or not existing.get("previewChanges"):
        raise HTTPException(status_code=409, detail="No pending fix preview is available for this run")
    if existing.get("requestedBy") != request.requestedBy:
        raise HTTPException(status_code=403, detail="Only the preview owner can commit this fix")
    if request.hotfix and len(existing["previewChanges"]) != 1:
        raise HTTPException(status_code=400, detail="Hotfix requires a preview that changes exactly one services file")
    if int(existing.get("previewExpiresAt") or 0) < int(time.time() * 1000):
        raise HTTPException(status_code=410, detail="Fix preview expired; prepare it again")
    attempt_id = uuid.uuid4().hex[:16]

    def claim(current):
        if isinstance(current, dict) and current.get("status") == "preview" and current.get("requestedBy") == request.requestedBy:
            current["status"] = "committing"
            current["hotfix"] = request.hotfix
            current["commitAttemptId"] = attempt_id
            current["commitStartedAt"] = int(time.time() * 1000)
        return current

    existing = trace.transaction(claim) or {}
    if existing.get("commitAttemptId") != attempt_id:
        raise HTTPException(status_code=409, detail="This preview is already being committed or is no longer available")
    git_committed = False
    try:
        github = GitHubServices(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ.get("GITHUB_BASE_BRANCH", "main"), request.runId, True, request.hotfix)
        github.commit_preview_batch(existing["previewChanges"], request.commitMessage, existing.get("report", ""), request.requestedByEmail or request.requestedBy)
        git_committed = True
        source_commit = next((str(change.get("commit")) for change in github.changes if str(change.get("path", "")).startswith("services/")), "")
        fix_id = f"fix_{request.runId}"
        fix_record = fix_store.save(
            fix_id=fix_id, workspace_id=request.workspaceId, run_id=request.runId,
            repository=os.environ["GITHUB_REPOSITORY"], base_branch=github.base_branch,
            target_branch=github.branch, commit_sha=source_commit,
            commit_message=request.commitMessage, hotfix=request.hotfix,
            requested_by=request.requestedBy, requested_by_email=request.requestedByEmail,
            report=existing.get("report", ""), changes=github.changes,
            log_ids=existing.get("logIds", []), patches=existing["previewChanges"],
        )
        result = {"runId": request.runId, "fixId": fix_id, "fix": fix_record, "report": existing.get("report", ""), "branch": github.branch, "changes": github.changes, "hotfix": request.hotfix, "commitMessage": request.commitMessage}
        trace.update({**result, "status": "completed", "committedAt": {".sv": "timestamp"}, "previewChanges": None})
        try:
            mark_logs_fixed(request.workspaceId, existing.get("logIds", []), request.requestedByEmail or request.requestedBy, fix_id, request.runId, github.branch, github.changes, request.commitMessage)
            trace.update({"logsMarkedFixed": True})
        except Exception as fixed_error:
            trace.update({"logsMarkedFixed": False, "fixedMarkError": str(fixed_error)[:1000]})
            result["warning"] = "Commit succeeded, but log fixed status could not be updated"
        return result
    except Exception as error:
        next_status = "commit_unknown" if git_committed else "preview"
        trace.update({"status": next_status, "commitAttemptId": None, "commitError": str(error)[:2000]})
        raise HTTPException(status_code=500, detail=str(error)[:2000]) from error


@app.post("/v1/history")
def save_history(request: HistoryRequest, x_agent_secret: str = Header(default="")):
    authorize(x_agent_secret)
    validate_segment(request.workspaceId, "workspaceId")
    validate_segment(request.requestedBy, "requestedBy")
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
