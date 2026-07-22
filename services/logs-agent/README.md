# Logs Agent

Independent CrewAI service that diagnoses Firebase application logs against the
GitHub source tree under `services/**`.

## Boundaries

- The service is not embedded in Next.js or deployed as part of Vercel.
- Requests require `X-Agent-Secret`.
- GitHub access is limited in code to `services/**`.
- Analysis mode cannot write.
- Apply mode creates a descriptive `fix/<english-purpose>-<run-id>` branch and
  uses an English commit message describing what the correction resolves.
- Explicit hotfix mode may commit directly to the configured base branch and is
  restricted to one `services/**` source file per run.
- Logs are treated as untrusted diagnostic input.
- The agent's primary role is surgical bug correction against the current
  implementation. It cannot use a fix run for unrelated features, refactors,
  dependencies, cleanup, or speculative behavior.
- Reports keep the complete evidence-based improvement proposal separate from
  the minimal safe fix. Optional proposal items are never applied automatically.
- Analysis prepares and stores an exact validated diff without writing GitHub.
  The Problem tab retains the diagnosis, Git preview exposes the ready code, and
  one explicit confirmation commits that preview to a descriptive branch or,
  for one file, directly to the selected base branch.
- Preview commits are atomic: source changes and `CHANGELOGS.md` share one Git
  commit. A stale source SHA, expired preview, or concurrent confirmation is
  rejected before updating a branch.
- Production guards include constant-time service authentication, bounded agent
  concurrency, request-size limits, LLM timeouts/retries, mandatory source reads,
  no-op/destructive-change rejection, safe GitHub read retries, readiness checks,
  a non-root read-only container, dropped capabilities, and a writable tmpfs only.
- Runs are stored at `workspaces/<workspaceId>/agent_runs/<runId>`.
- Applied fixes are stored independently in the agent's persistent SQLite database
  at `LOGS_AGENT_DATABASE_PATH`. Firebase log records retain `agentFixId` so the
  logs UI can resolve the exact commit, branch, files, requester, and timestamp.
- New fix records retain a private before/after snapshot and can prepare the exact
  correction again. Reapply refuses files that already contain the fix or differ
  from the original pre-fix version, and still requires preview confirmation.

## API

The API supports both workflows explicitly:

- `POST /v1/analyze-and-fix`: diagnoses and prepares the validated Git preview.
- `POST /v1/analyze`: diagnoses without preparing or writing source code.
- `POST /v1/fix`: accepts `analysisRunId` from an analysis-only run and prepares
  its preview later. Only the same workspace/user may continue that run.
- `POST /v1/commit`: commits a previously reviewed preview.
- `POST /v1/diagnose`: backward-compatible endpoint controlled by the existing
  `apply` and `preview` flags.

Combined flow (`POST /v1/analyze-and-fix`):

```json
{
  "logs": [],
  "instruction": "Focus on repeated tunnel failures",
  "format": "markdown",
  "workspaceId": "default",
  "requestedBy": "firebase-user-id",
  "requestedByEmail": "admin@example.com"
}
```

Separate flow, first `POST /v1/analyze` with the same log payload, then:

```json
{
  "analysisRunId": "analysis-run-id",
  "instruction": "Prepare the minimal correction",
  "format": "markdown",
  "workspaceId": "default",
  "requestedBy": "firebase-user-id",
  "requestedByEmail": "admin@example.com"
}
```

The Next.js logs application adds the workspace and user fields after checking
the administrator session. Do not expose this endpoint publicly without a long
random `LOGS_AGENT_SECRET` and HTTPS.

## GitHub permissions

Use a fine-grained token scoped to the configured repository. Analysis needs
Contents read permission. Apply mode also needs Contents write permission.
Branch protection should require review before merge.

## Run and test

```bash
docker compose up -d --build logs-agent logs
docker run --rm -v "$PWD/services/logs-agent/tests:/app/tests:ro" \
  docker-panel-lite-logs-agent python -m unittest discover -s /app/tests -v
```

Tests are mounted at runtime; application images contain runtime code only.
