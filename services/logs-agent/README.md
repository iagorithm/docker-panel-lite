# Logs Agent

Independent CrewAI service that diagnoses Firebase application logs against the
GitHub source tree under `services/**`.

## Boundaries

- The service is not embedded in Next.js or deployed as part of Vercel.
- Requests require `X-Agent-Secret`.
- GitHub access is limited in code to `services/**`.
- Analysis mode cannot write.
- Apply mode creates `logs-agent/<run-id>` and commits there; it never writes to
  the configured base branch.
- Logs are treated as untrusted diagnostic input.
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
