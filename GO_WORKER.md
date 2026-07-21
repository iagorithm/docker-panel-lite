# Go Worker Implementation Plan

Last updated: 2026-07-21

This document describes the Go implementation of the Docker Panel Lite worker while keeping the current Python worker available. The goal is to support both runtimes and let deployments choose which worker image to run.

## Current Status

The Go worker is **not yet a complete replacement** for the Python worker.

Current Go implementation in `services/worker-go` supports:

- Configuration loading compatible with the Python worker environment.
- Firebase Realtime Database REST client using service-account OAuth.
- Stable worker identity.
- Persistent worker claim token.
- SHA-256 worker token hash.
- Online/offline heartbeat.
- Preservation of owner and sharing metadata during heartbeat.
- Runtime metadata: `runtime: "go"`, Go version, worker version placeholder, and feature list.
- Docker availability summary through Docker CLI.
- Queue polling for configured shards.
- ETag-based conditional job leasing.
- Lease renewal while jobs are active.
- Repository/container locks.
- Container inventory publication.
- Container start, stop, restart, delete, and logs actions.
- `inventory_refresh` jobs.
- AES-GCM credential decryption.
- Git branch discovery, clone, pull, and sync.
- `read_compose`.
- Basic Compose deploy/stop through Docker CLI.
- Basic Dockerfile build/run/stop through Docker CLI.
- Docker image build scaffold.
- Docker Compose profile activation through `worker-go`.

Current Go implementation does **not** support yet:

- Firebase realtime queue listeners. The Go worker currently uses polling.
- Active command cancellation/interruption. It observes cancellation before execution and at completion.
- Public URL/tunnel actions.
- Worker commands.
- Container exec commands.

Production deploy actions should continue to use the Python worker until the Go worker reaches protocol and executor parity.

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
    worker/
      config.py
      firebase_runtime.py
      executor.py
      secrets.py
      main.py
      core/
        docker_ops.py
        git.py
        ngrok.py
        utils.py
  worker-go/               # New Go worker
    worker/
      main.go
      config/
        config.go
      firebase_runtime/
        client.go
      heartbeat/
        heartbeat.go
      identity/
        identity.go
      executor/
      secrets/
      core/
        docker_ops.go
        git.go
        ngrok.go
        utils.go
      queue/
      inventory/
    Dockerfile
    go.mod
```

Actual implemented Go layout today:

```text
services/worker-go/
  worker/main.go
  worker/config/config.go
  worker/core/docker_ops.go
  worker/firebase_runtime/client.go
  worker/heartbeat/heartbeat.go
  worker/identity/identity.go
  worker/queue/runner.go
  worker/executor/executor.go
  worker/secrets/secrets.go
  worker/core/git.go
  worker/core/utils.go
  Dockerfile
  README.md
  go.mod
```

Planned but not implemented yet:

```text
services/worker-go/worker/
  ngrok.go
```

## Python vs Go Parity Matrix

| Capability | Python worker | Go worker | Notes |
| --- | --- | --- | --- |
| Config loading | Complete | Implemented | Go reads env and optional worker config file. |
| Worker ID persistence | Complete | Implemented | Go persists `worker-id` in data dir. |
| Worker token persistence | Complete | Implemented | Go persists `worker-token` in data dir. |
| Claim token hash | Complete | Implemented | Go writes SHA-256 hash in heartbeat. |
| Firebase client | Complete | Implemented | Go uses REST + service-account OAuth. |
| Online/offline heartbeat | Complete | Implemented | Go sends heartbeat loop and shutdown offline status. |
| Preserve ownership/sharing | Complete | Implemented | Go reads current agent record before writing heartbeat. |
| Docker summary | Complete | Implemented | Go uses Docker CLI summary, not Docker SDK yet. |
| Container inventory | Complete | Implemented | Go publishes dashboard inventory from Docker CLI. |
| Queue polling/listening | Complete | Partial | Go polls queue shards. Realtime listeners are not implemented yet. |
| Job leasing | Complete | Implemented | Go uses Firebase REST ETags and conditional PUT. |
| Lease renewal | Complete | Implemented | Go extends job and lock leases while processing. |
| Repository lock | Complete | Implemented | Go locks by repository or container key before execution. |
| Cancellation | Complete | Partial | Go handles cancellation before execution and final status, but does not interrupt active Docker commands yet. |
| `inventory_refresh` | Complete | Implemented | Publishes container inventory. |
| `container_logs` | Complete | Implemented | Loads Docker log tail into container record. |
| `container_start` | Complete | Implemented | Uses Docker CLI. |
| `container_stop` | Complete | Implemented | Uses Docker CLI and worker protection. |
| `container_restart` | Complete | Implemented | Uses Docker CLI. |
| `container_delete` | Complete | Implemented | Uses Docker CLI and worker protection. |
| `container_exec` | Complete | Missing | Should wait for command hardening/allowlists. |
| `worker_command` | Complete | Missing | Should wait for command hardening/allowlists. |
| AES-GCM secret decrypt | Complete | Implemented | Compatible with app credential format. |
| Git clone/pull | Complete | Implemented | Uses Git CLI with token redaction. |
| `discover_branches` | Complete | Implemented | Uses `git ls-remote`. |
| `read_compose` | Complete | Implemented | Syncs repo and stores compose content up to 1 MB. |
| Compose deploy | Complete | Partial | Runs `docker compose up -d --build`; generated override parity still pending. |
| Dockerfile deploy | Complete | Partial | Builds image and runs container; advanced Docker SDK parity still pending. |
| `tunnel_start` | Complete | Missing | Needs ngrok process manager and target discovery. |
| `tunnel_stop` | Complete | Missing | Needs ngrok process manager. |
| Runtime display in dashboard | Complete | Implemented | Dashboard shows Python/Go runtime from heartbeat. |
| Compose profile | Complete | Implemented | `docker compose --profile go-worker` includes `worker-go`. |
| Local Go container startup | Complete | Implemented | `./run.sh up-go` builds and starts `web` + `worker-go` without starting Python worker. |

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
NGROK_ENABLED=false
NGROK_AUTHTOKEN=
NGROK_REGION=
```

## Implementation Phases

### Phase 0: Contract and Test Fixtures

Status: implemented for branch discovery, credential decrypt, clone, pull, sync, and `read_compose`.

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

Status: implemented in `services/worker-go`.

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

- Go worker appears in dashboard. Done.
- Go worker can be claimed with the existing worker token flow. Done.
- Go worker preserves ownership and sharing on heartbeat. Done.
- Go worker marks itself offline on shutdown. Done.
- Go worker reports Docker summary. Done.
- Dashboard displays Go runtime correctly. Done.

### Phase 2: Queue Leasing

Status: mostly implemented.

Deliverables:

- Queue shard polling. Done.
- Optional Firebase realtime listener if practical. Pending.
- Job lease transaction. Done with Firebase REST ETags and conditional PUT.
- Lease renewal while job runs. Done.
- Cancellation detection. Partial. Go handles cancellation before execution and final status, but does not interrupt active Docker commands yet.
- Active job tracking. Done.
- Max concurrency enforcement. Done.

Acceptance criteria:

- Go worker leases only jobs assigned to its pool/shards. Done.
- Go worker respects `targetWorkerId`. Done.
- Go worker does not process jobs owned by another worker. Done.
- Expired leases can be recovered safely. Done.

### Phase 3: Container Inventory and Basic Container Actions

Status: implemented for Docker CLI based inventory and basic actions.

Deliverables:

- Docker client wrapper. Done with Docker CLI.
- Inventory collection. Done.
- `inventory_refresh`. Done.
- `container_logs`. Done.
- `container_start`. Done.
- `container_stop`. Done.
- `container_restart`. Done.
- `container_delete`. Done.
- Worker container protection. Done for stop/delete/exec.

Acceptance criteria:

- Dashboard container inventory updates correctly. Needs live workspace validation.
- Logs are returned and truncated safely. Done.
- Worker container cannot be stopped, deleted, or exec'd. Done.

### Phase 4: Git and Credential Decryption

Status: not implemented.

Deliverables:

- AES-256-GCM secret decryptor compatible with `apps/web/lib/secrets.ts`. Done.
- Git credential injection with output redaction. Done.
- Clone/pull logic. Done.
- Branch discovery. Done.
- `read_compose`. Done.

Acceptance criteria:

- Go worker can clone public and private repositories.
- Git tokens are not logged.
- `read_compose` returns compose content with the same limits as Python.

### Phase 5: Docker Compose and Dockerfile Deployments

Status: partially implemented.

Deliverables:

- Compose file path validation. Done.
- Dockerfile path validation. Done.
- `.env` file writer. Done.
- Docker Compose deploy/stop. Done.
- Dockerfile image build. Done.
- Managed container run/replace. Done.
- Environment variable handling. Partial. Go writes `.env` and process env, but does not yet generate the Python worker's Compose override file.

Acceptance criteria:

- Existing repositories deploy with Go worker. Needs live repository validation.
- Compose and Dockerfile modes work. Implemented, needs live repository validation.
- Path traversal outside clone directory is blocked. Done.
- Environment format is compatible with Python worker behavior. Partial.

### Phase 6: Public URLs

Status: not implemented.

Deliverables:

- Ngrok process manager.
- `tunnel_start`.
- `tunnel_stop`.
- Per-service tunnel support.
- Public URL status updates.
- Worker network connection for tunnel targets.

Acceptance criteria:

- Public URLs work for Compose and Dockerfile projects.
- Tunnel metadata matches existing dashboard expectations.
- Stopping tunnels clears repository public URL state.

### Phase 7: Worker and Container Commands

Status: not implemented.

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

Current implementation:

- Firebase: standard-library REST client with service-account OAuth.
- Docker summary: Docker CLI through `os/exec`.
- Crypto: standard library.
- No external Go modules currently.

Suggested future packages:

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
RUN CGO_ENABLED=0 go build -o /out/docker-panel-worker ./worker

FROM alpine:3.22
RUN apk add --no-cache git ca-certificates curl docker-cli docker-cli-compose
COPY --from=builder /out/docker-panel-worker /usr/local/bin/docker-panel-worker
CMD ["docker-panel-worker"]
```

## Dashboard Changes

Status: implemented.

The dashboard now displays runtime metadata in the worker card:

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

The dashboard should not branch behavior by runtime unless a feature is missing. Once the Go worker starts processing jobs, the dashboard may use `features` to disable actions that are not available for a specific worker.

## Build and Publish Changes

Status: partially implemented.

Implemented:

- `worker-go` service in `docker-compose.yaml` under the `go-worker` profile.
- `worker-go` build target in `docker-compose.build.yaml`.
- `WORKER_GO_IMAGE` in `.env.example`.
- `services/worker-go/Dockerfile`.
- `./run.sh up-go`, `./run.sh build-go`, and `./run.sh logs-go` for local Go worker development.
- `WORKER_RUNTIME=go ./run-local.sh` for a one-command local app + Go worker stack.

Not implemented:

- `run.sh` commands for build/publish by runtime.
- Publish script support for Go-specific tags.
- Runtime-specific `python` and `go` publish commands.

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

1. Build Go worker heartbeat only. Done.
2. Run Go worker in a dev workspace with no production credentials. Pending.
3. Claim Go worker from dashboard. Supported by code, needs environment test.
4. Enable inventory refresh. Implemented, needs live workspace validation.
5. Enable logs and basic container actions. Implemented, needs live workspace validation.
6. Enable Git sync and branch discovery. Implemented, needs live repository validation.
7. Enable Compose/Dockerfile deployments. Partially implemented, needs live repository validation and Compose override parity.
8. Enable tunnels. Pending.
9. Run Python and Go workers side by side in separate pools. Pending.
10. Move one low-risk project to Go. Pending.
11. Promote Go to beta. Pending.
12. Promote Go to default only after parity and operational confidence. Pending.

## Open Questions

- Should Go use Firebase realtime listeners or polling first? Current recommendation: implement polling first for correctness, add realtime listener later for latency.
- Should `worker_command` be implemented immediately or wait for command allowlists?
- Should Go share the same worker data directory format as Python? Current implementation already shares `worker-id` and `worker-token` file names.
- Should the worker image still support baked config, or should Go runtime require env/secrets only?
- Should `latest` eventually point to Go, or should users always select explicit runtime tags?

## Immediate Next Implementation Steps

1. Add live workspace validation for Go queue leasing and container actions.
2. Add live repository validation for Git, Compose, and Dockerfile jobs.
3. Add Compose environment override parity with the Python worker.
4. Add active cancellation/interruption for long Docker commands.
5. Add ngrok tunnel start/stop parity.
6. Add deploy log streaming and richer progress updates.
7. Add command allowlists before enabling `worker_command` and `container_exec`.
8. Add contract fixtures shared by Python and Go.
9. Add integration tests for encrypted credentials and private repos.
10. Add safer cleanup/rollback behavior for failed Dockerfile deploys.

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
