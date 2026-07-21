# Go Worker Implementation Plan

Last updated: 2026-07-21

This document describes how to add a Go implementation of the Docker Panel Lite worker while keeping the current Python worker available. The goal is to support both runtimes and let deployments choose which worker image to run.

## Goal

Docker Panel Lite should support two compatible worker runtimes:

- Python worker: current stable implementation in `services/worker`.
- Go worker: new compiled implementation in `services/worker-go`.

Both workers must speak the same Firebase job protocol, report the same worker heartbeat shape, support the same ownership/sharing model, and execute the same deployment actions.

## Why Build a Go Worker

The Go worker is attractive because it can ship as a compiled binary with fewer runtime dependencies.

Expected advantages:

- Smaller runtime image.
- Faster startup.
- Easier multi-architecture builds.
- Fewer package/runtime dependencies.
- Easier static analysis and packaging.
- Better fit for a long-running systems agent.
- Potential to use distroless or scratch-style images later.

Important caution:

The main risk is not compiling the worker. The hard part is protocol parity with the Python worker: leasing, cancellation, Firebase updates, Docker operations, logs, secrets, inventory, tunnels, and failure handling must behave the same way.

## Proposed Repository Layout

```text
services/
  worker/                  # Existing Python worker
  worker-go/               # New Go worker
    cmd/
      worker/
        main.go
    internal/
      config/
      firebase/
      queue/
      executor/
      docker/
      git/
      secrets/
      ngrok/
      heartbeat/
      inventory/
    Dockerfile
    go.mod
    go.sum
```

## Runtime Selection

Add runtime selection through environment variables.

```env
WORKER_RUNTIME=python
# or
WORKER_RUNTIME=go
```

Recommended image variables:

```env
WORKER_PYTHON_IMAGE=cjarn/docker-panel-lite-worker:python
WORKER_GO_IMAGE=cjarn/docker-panel-lite-worker:go
WORKER_RUNTIME=python
```

Possible compose strategy:

```yaml
worker:
  image: ${WORKER_IMAGE:-cjarn/docker-panel-lite-worker:${WORKER_RUNTIME:-python}}
```

More explicit compose strategy:

```yaml
worker-python:
  profiles: ["python-worker"]
  image: ${WORKER_PYTHON_IMAGE:-cjarn/docker-panel-lite-worker:python}

worker-go:
  profiles: ["go-worker"]
  image: ${WORKER_GO_IMAGE:-cjarn/docker-panel-lite-worker:go}
```

Recommended first version:

- Keep `latest` pointing to Python.
- Publish Go as `:go`.
- Let users opt in with `WORKER_RUNTIME=go` or `WORKER_IMAGE=...:go`.

## Image Tagging

Recommended tags:

```text
cjarn/docker-panel-lite-worker:python
cjarn/docker-panel-lite-worker:python-<version>
cjarn/docker-panel-lite-worker:go
cjarn/docker-panel-lite-worker:go-<version>
cjarn/docker-panel-lite-worker:latest
```

Transition policy:

1. `latest` remains Python until Go reaches feature parity.
2. Go is opt-in.
3. After parity and production testing, `latest` can move to Go.
4. Keep Python tags available as rollback.

## Shared Worker Contract

Before implementing Go, create a formal worker contract document, for example:

```text
docs/WORKER_RUNTIME_CONTRACT.md
```

The contract must define the exact Firebase protocol both workers implement.

### Heartbeat Path

```text
workspaces/{workspaceId}/agents/{workerId}
```

Required fields:

```json
{
  "id": "worker-default-abc123",
  "runtime": "go",
  "runtimeVersion": "1.0.0",
  "workerVersion": "git-sha-or-version",
  "identitySource": "machine-id",
  "label": "Mexica",
  "hostname": "host-name",
  "location": "",
  "poolId": "default",
  "status": "online",
  "activeJobs": 0,
  "maxConcurrency": 2,
  "shards": ["00", "01"],
  "lastHeartbeat": 1760000000000,
  "startedAt": 1760000000000,
  "pid": 123,
  "platform": "linux/amd64",
  "cloneDir": "/app/clones",
  "dataDir": "/app/data",
  "docker": {
    "available": true,
    "serverVersion": "",
    "apiVersion": "",
    "os": "",
    "architecture": "",
    "containers": 0,
    "containersRunning": 0,
    "images": 0
  },
  "traefikEnabled": false,
  "traefikNetwork": "proxy",
  "ngrokEnabled": false,
  "ngrokRegion": "",
  "leaseSeconds": 90,
  "pollSeconds": 5,
  "sharing": "private",
  "shared": false,
  "public": false,
  "sharedEmails": [],
  "workerTokenHash": "sha256-token",
  "claimedAt": null,
  "claimedBy": "",
  "ownerUid": "",
  "ownerEmail": ""
}
```

The Go worker must preserve existing ownership and sharing fields on heartbeat, just like the Python worker.

### Job Path

```text
jobs/{jobId}
```

Mirrored path:

```text
workspaces/{workspaceId}/deployments/{jobId}
```

Queue path:

```text
queues/{poolId}/{shardId}/{jobId}
```

### Supported Job States

```text
queued
leased
running
completed
failed
cancelled
```

The worker must update both `jobs/{jobId}` and `workspaces/{workspaceId}/deployments/{jobId}` consistently.

### Supported Actions

Repository actions:

- `sync`
- `deploy`
- `build`
- `stop`
- `discover_branches`
- `read_compose`
- `tunnel_start`
- `tunnel_stop`

Container actions:

- `inventory_refresh`
- `container_start`
- `container_stop`
- `container_restart`
- `container_delete`
- `container_logs`
- `container_exec`

Worker actions:

- `worker_command`

## Configuration Parity

The Go worker should support the same environment variables as the Python worker.

Required:

```env
FIREBASE_DATABASE_URL=
FIREBASE_SERVICE_ACCOUNT_JSON=
CREDENTIAL_ENCRYPTION_KEY=
WORKER_WORKSPACE_ID=default
WORKER_POOL=default
QUEUE_SHARDS=16
```

Worker identity:

```env
WORKER_ID=
WORKER_TOKEN=
WORKER_MACHINE_ID=
WORKER_LABEL=
WORKER_LOCATION=
```

Execution:

```env
APP_DATA_DIR=/app/data
APP_CLONE_DIR=/app/clones
WORKER_SHARDS=
WORKER_MAX_CONCURRENCY=2
WORKER_LEASE_SECONDS=90
WORKER_POLL_SECONDS=5
```

Public routing:

```env
TRAEFIK_ENABLED=false
TRAEFIK_NETWORK=proxy
NGROK_ENABLED=false
NGROK_AUTHTOKEN=
NGROK_REGION=
```

## Implementation Phases

### Phase 0: Contract and Test Fixtures

Deliverables:

- Create `docs/WORKER_RUNTIME_CONTRACT.md`.
- Add sample Firebase job payloads.
- Add sample repository payloads.
- Add sample worker heartbeat payloads.
- Define expected updates for success, failure, timeout, and cancellation.

Acceptance criteria:

- Python and Go workers can be tested against the same fixtures.
- The dashboard does not need to know which runtime processed the job.

### Phase 1: Minimal Go Worker

Status: partially implemented in `services/worker-go`.

Deliverables:

- `services/worker-go` scaffold. Done.
- Config loader. Done.
- Firebase REST client with service-account OAuth. Done.
- Persistent worker ID. Done.
- Persistent worker token. Done.
- Worker token SHA-256 hash. Done.
- Heartbeat writer. Done.
- Online/offline lifecycle. Done.
- Docker summary. Done.
- Runtime metadata in heartbeat. Done.

Acceptance criteria:

- Go worker appears in dashboard.
- Go worker can be claimed with the existing worker token flow.
- Go worker preserves ownership and sharing on heartbeat.
- Go worker marks itself offline on shutdown.

### Phase 2: Queue Leasing

Deliverables:

- Queue shard polling.
- Optional Firebase realtime listener if practical.
- Job lease transaction.
- Lease renewal while job runs.
- Cancellation detection.
- Active job tracking.
- Max concurrency enforcement.

Acceptance criteria:

- Go worker leases only jobs assigned to its pool/shards.
- Go worker respects `targetWorkerId`.
- Go worker does not process jobs owned by another worker.
- Expired leases can be recovered safely.

### Phase 3: Container Inventory and Basic Container Actions

Deliverables:

- Docker client wrapper.
- Inventory collection.
- `inventory_refresh`.
- `container_logs`.
- `container_start`.
- `container_stop`.
- `container_restart`.
- `container_delete`.
- Worker container protection.

Acceptance criteria:

- Dashboard container inventory updates correctly.
- Logs are returned and truncated safely.
- Worker container cannot be stopped, deleted, or exec'd.

### Phase 4: Git and Credential Decryption

Deliverables:

- AES-256-GCM secret decryptor compatible with `apps/web/lib/secrets.ts`.
- Git credential injection with output redaction.
- Clone/pull logic.
- Branch discovery.
- `read_compose`.

Acceptance criteria:

- Go worker can clone public and private repositories.
- Git tokens are not logged.
- `read_compose` returns compose content with the same limits as Python.

### Phase 5: Docker Compose and Dockerfile Deployments

Deliverables:

- Compose file path validation.
- Dockerfile path validation.
- `.env` file writer.
- Docker Compose deploy/stop.
- Dockerfile image build.
- Managed container run/replace.
- Environment variable handling.

Acceptance criteria:

- Existing repositories deploy with Go worker.
- Compose and Dockerfile modes work.
- Path traversal outside clone directory is blocked.
- Environment format is compatible with Python worker behavior.

### Phase 6: Public URLs and Traefik

Deliverables:

- Ngrok process manager.
- `tunnel_start`.
- `tunnel_stop`.
- Per-service tunnel support.
- Public URL status updates.
- Traefik override generation.
- Worker network connection for tunnel targets.

Acceptance criteria:

- Public URLs work for Compose and Dockerfile projects.
- Tunnel metadata matches existing dashboard expectations.
- Stopping tunnels clears repository public URL state.

### Phase 7: Worker and Container Commands

Deliverables:

- `worker_command`.
- `container_exec`.
- Timeout handling.
- Output truncation.
- Non-interactive Compose exec normalization.
- Shell command behavior compatible with Python worker.

Acceptance criteria:

- Commands behave the same as Python worker.
- Timeouts return useful output.
- Worker container protection still applies.

Security note:

This phase should be gated behind the future command hardening work from `SECURITY.md`. Ideally, the Go worker should support command allowlists from day one.

## Go Technology Choices

Suggested packages:

- Firebase/Auth/Database: official Google/Firebase Admin Go SDK where possible.
- Docker: `github.com/docker/docker/client`.
- Git: shell out to `git` initially for parity with Python.
- YAML: `gopkg.in/yaml.v3`.
- Ngrok: manage the `ngrok` binary initially for parity.
- Crypto: standard library `crypto/aes`, `crypto/cipher`, `crypto/sha256`.

Recommended approach:

- Use Docker SDK for container operations.
- Use Docker CLI for Compose because Compose is a Docker CLI plugin.
- Use Git CLI initially to match current behavior and credential handling.

## Dockerfile Plan

Initial Go worker image can still include:

- `git`
- Docker CLI
- Docker Compose plugin
- `ngrok`
- compiled Go worker binary

Later hardening:

- Multi-stage build.
- Distroless runtime if Docker CLI/Compose/ngrok packaging permits.
- Non-root runtime where compatible with Docker socket permissions.

Example outline:

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY services/worker-go/go.mod services/worker-go/go.sum ./
RUN go mod download
COPY services/worker-go ./
RUN CGO_ENABLED=0 go build -o /out/docker-panel-worker ./cmd/worker

FROM alpine:3.22
RUN apk add --no-cache git ca-certificates curl docker-cli docker-cli-compose
COPY --from=builder /out/docker-panel-worker /usr/local/bin/docker-panel-worker
CMD ["docker-panel-worker"]
```

## Dashboard Changes

Add runtime metadata display in the worker card:

- Runtime: Python or Go.
- Version.
- Feature flags.
- Docker availability.

Heartbeat additions:

```json
{
  "runtime": "go",
  "runtimeVersion": "1.0.0",
  "workerVersion": "git-sha",
  "features": ["docker", "compose", "git", "tunnels"]
}
```

The dashboard should not branch behavior by runtime unless a feature is missing.

## Build and Publish Changes

Add commands:

```bash
./run.sh build-worker-python
./run.sh build-worker-go
./run.sh publish-worker-python
./run.sh publish-worker-go
```

Or add one command with runtime:

```bash
WORKER_RUNTIME=go ./run.sh publish-worker
WORKER_RUNTIME=python ./run.sh publish-worker
```

Publishing should create runtime-specific tags:

```text
worker:go
worker:go-<git-sha>
worker:python
worker:python-<git-sha>
```

## Testing Strategy

### Unit Tests

Test:

- Config parsing.
- Worker ID/token persistence.
- AES-GCM decrypt compatibility.
- Path validation.
- Safe project name generation.
- Queue shard selection.
- Job state transitions.
- Docker/Compose command construction.

### Contract Tests

Use the same fixtures for Python and Go:

- Given a queued job, worker leases it.
- Given a cancellation request, worker stops or marks cancelled.
- Given a failed command, worker writes failed state.
- Given success, worker writes completed state and mirrored deployment updates.

### Integration Tests

Run with Docker Compose:

- Firebase emulator if practical.
- One Python worker and one Go worker in separate pools.
- Deploy a sample Compose repository.
- Deploy a sample Dockerfile repository.
- Refresh inventory.
- Read logs.
- Start/stop/restart/delete test containers.

### Migration Tests

- Claim a Python worker.
- Stop Python worker.
- Start Go worker with same mounted `/app/data`.
- Confirm worker ID and token remain stable if intended.
- Confirm dashboard ownership and sharing survive.

## Security Requirements

The Go worker must not weaken existing controls.

Required:

- Never store raw worker token in Firebase.
- Do not log Git tokens, ngrok tokens, Firebase credentials, or decrypted secrets.
- Validate repository file paths stay inside clone directory.
- Protect the worker container from stop/delete/exec.
- Truncate logs and command output.
- Preserve owner/sharing fields during heartbeat.
- Respect `targetWorkerId`.
- Respect job lease ownership.
- Avoid shell execution except where intentionally required for container exec or Compose parity.

Recommended:

- Implement command allowlists before enabling `worker_command`.
- Add audit events for command execution.
- Use least-privilege Firebase service accounts.
- Prefer runtime secrets over baked image config.

## Rollout Plan

1. Build Go worker heartbeat only.
2. Run Go worker in a dev workspace with no production credentials.
3. Claim Go worker from dashboard.
4. Enable inventory refresh.
5. Enable logs and basic container actions.
6. Enable Git sync and branch discovery.
7. Enable Compose/Dockerfile deployments.
8. Enable tunnels.
9. Run Python and Go workers side by side in separate pools.
10. Move one low-risk project to Go.
11. Promote Go to beta.
12. Promote Go to default only after parity and operational confidence.

## Open Questions

- Should Go use Firebase realtime listeners or polling first?
- Should `worker_command` be implemented immediately or wait for command allowlists?
- Should Go share the same worker data directory format as Python?
- Should the worker image still support baked config, or should Go runtime require env/secrets only?
- Should `latest` eventually point to Go, or should users always select explicit runtime tags?

## Success Criteria

The Go worker is ready for production consideration when:

- It can be claimed through the existing UI.
- It preserves ownership/sharing across restarts.
- It processes all supported job actions.
- It passes contract tests against the same fixtures as Python.
- It can deploy existing Compose and Dockerfile repositories.
- It can refresh inventory and manage containers.
- It can expose and close public URLs.
- It has clear logs and safe failure handling.
- It has documented rollback to the Python worker.
