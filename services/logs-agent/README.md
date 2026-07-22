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
- Applying is two-phase: the agent first stores and returns an exact validated
  diff without writing GitHub; an explicit confirmation commits that same
  preview to a descriptive branch or, for one file, directly to the base branch.
- Preview commits are atomic: source changes and `CHANGELOGS.md` share one Git
  commit. A stale source SHA, expired preview, or concurrent confirmation is
  rejected before updating a branch.
- Production guards include constant-time service authentication, bounded agent
  concurrency, request-size limits, LLM timeouts/retries, mandatory source reads,
  no-op/destructive-change rejection, safe GitHub read retries, readiness checks,
  a non-root read-only container, dropped capabilities, and a writable tmpfs only.
- Runs are stored at `workspaces/<workspaceId>/agent_runs/<runId>`.

## API

`POST /v1/diagnose`

```json
{
  "logs": [],
  "instruction": "Focus on repeated tunnel failures",
  "format": "markdown",
  "apply": false,
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
