# Worker Design

## Purpose

The worker is the execution agent for Docker Panel Lite. It runs on a Docker
host, connects to Firebase, reports its health and container inventory, leases
queued jobs, and executes deployment or container operations on behalf of the
web dashboard.

This document describes the worker requirements and expected behavior
independently of implementation language. Any runtime that follows this design
must speak the same Firebase protocol, preserve the same ownership model, and
produce compatible updates for the dashboard.

## Core Responsibilities

The worker is responsible for:

- Registering itself as an agent in a workspace.
- Maintaining a stable worker identity across restarts.
- Producing and protecting a claim token used to assign ownership.
- Sending lifecycle heartbeats.
- Publishing Docker availability and container inventory.
- Polling or listening for queued jobs.
- Leasing jobs safely so only one worker executes each job.
- Renewing active job leases.
- Locking repositories or containers while operations are running.
- Executing repository, container, command, and tunnel actions.
- Reporting progress, final status, messages, command output, and errors.
- Cleaning queue entries and releasing locks after completion.

The worker is not an authentication authority. User access decisions are made by
the web application before a job is queued. The worker still enforces local
safety checks such as worker-container protection, path validation, and command
timeouts.

## Runtime Configuration

The worker reads configuration from environment variables and may also read a
fallback config file packaged with the worker image.

Required configuration:

- Firebase Realtime Database URL or project identity.
- Firebase service account credentials.
- Credential encryption key.
- Workspace ID.

Common worker configuration:

- `WORKER_ID`: explicit stable worker ID. Usually omitted.
- `WORKER_TOKEN`: explicit claim token. Usually omitted.
- `WORKER_LABEL`: human-readable label displayed in the dashboard.
- `WORKER_LOCATION`: optional host/location description.
- `WORKER_POOL`: queue pool, default `default`.
- `WORKER_SHARDS` or `QUEUE_SHARDS`: queue shards the worker should scan.
- `WORKER_MAX_CONCURRENCY`: maximum simultaneous jobs.
- `WORKER_LEASE_SECONDS`: job and lock lease duration.
- `WORKER_POLL_SECONDS`: polling interval when realtime listeners are not used.
- `APP_CLONE_DIR`: repository clone directory.
- `APP_DATA_DIR`: persistent worker state directory.
- `NGROK_ENABLED`, `NGROK_AUTHTOKEN`, `NGROK_REGION`, `NGROK_BIN`: public tunnel configuration.

Runtime environment values should override baked/default values.

## Persistent Identity

Each worker has a stable ID used for routing jobs and owning container records.

Worker ID resolution order:

1. Use `WORKER_ID` when explicitly configured.
2. Derive a stable ID from a host or Docker fingerprint when available.
3. Read an existing persisted ID from the worker data directory.
4. Generate and persist a new ID if no stable source exists.

The worker ID is not secret. It is safe to store in Firebase and display in
logs or the dashboard.

## Claim Token

Each worker has a claim token that proves the operator has access to that worker
installation.

Expected behavior:

- Use `WORKER_TOKEN` when explicitly configured.
- Otherwise generate a secure token.
- Persist generated tokens under the worker data directory.
- Store only a SHA-256 hash of the token in Firebase.
- Print the raw token in local worker logs so an operator can claim the worker.

The raw claim token is sensitive. Anyone with access to it may claim an
unclaimed worker. After a worker is claimed, ownership and sharing rules control
visibility and usage.

## Firebase Data Model

The worker communicates through Firebase Realtime Database.

Main paths:

```text
workspaces/{workspaceId}/agents/{workerId}
jobs/{jobId}
workspaces/{workspaceId}/deployments/{jobId}
queues/{poolId}/{shardId}/{jobId}
locks/{workspaceId}/{lockKey}
workspaces/{workspaceId}/repositories/{repositoryId}
workspaces/{workspaceId}/containers/{containerId}
workspaces/{workspaceId}/environment
secrets/credentials/{workspaceId}/{credentialId}
secrets/ngrok/{workspaceId}/{repositoryId}
```

The worker must update both `jobs/{jobId}` and
`workspaces/{workspaceId}/deployments/{jobId}` when changing job status,
progress, messages, lease state, command output, or completion metadata.

## Heartbeat

The worker sends a heartbeat to:

```text
workspaces/{workspaceId}/agents/{workerId}
```

Heartbeat state includes:

- Worker ID, label, hostname, location, pool, shards, and runtime metadata.
- Status: `online`, `stopping`, or `offline`.
- Active job count and max concurrency.
- Lease and polling settings.
- Clone and data directory paths.
- Docker availability summary.
- Ngrok enabled/region status.
- Worker claim token hash.
- Last heartbeat timestamp.
- Startup timestamp.

The worker must preserve owner and sharing fields that already exist on the
agent record. Heartbeats must not erase:

- `claimedAt`
- `claimedBy`
- `ownerUid`
- `ownerEmail`
- `sharing`
- `shared`
- `public`
- `sharedEmails`

On graceful shutdown, the worker should send an `offline` heartbeat.

## Container Inventory

The worker periodically inspects Docker and publishes container records under:

```text
workspaces/{workspaceId}/containers/{containerRecordId}
```

Each container record should include:

- Stable dashboard record ID.
- Docker container ID.
- Name, image, status, ports, compose project, compose service.
- Worker ID, label, hostname, and pool.
- Last seen timestamp.
- Updated timestamp.
- Worker-container marker.
- Protected actions.

Worker containers must be protected from stop, delete, and exec actions through
both UI metadata and worker-side checks.

If a container previously owned by the worker disappears, the worker should
remove or mark the dashboard record as no longer present.

## Queue Flow

The dashboard creates a job and places a queue item under:

```text
jobs/{jobId}
queues/{poolId}/{shardId}/{jobId}
workspaces/{workspaceId}/deployments/{jobId}
```

Worker flow:

1. Scan or listen to configured queue shards.
2. Skip queue items targeted to another worker.
3. Respect max concurrency.
4. Read the canonical job from `jobs/{jobId}`.
5. Claim the job only if it is queued or safely recoverable from an expired lease.
6. Set status to `leased`, assign `workerId`, increment attempt, and set `leaseExpiresAt`.
7. Acquire a repository/container lock.
8. Publish status `running` and initial progress.
9. Renew lease and lock while the job runs.
10. Execute the requested action.
11. Publish success, failure, or cancellation.
12. Delete the queue item.
13. Release the lock.
14. Refresh heartbeat and inventory when appropriate.

Leasing must be conditional or transactional. Two workers must not be able to
claim and run the same job at the same time.

## Locks

The worker uses locks to avoid conflicting operations.

Lock path:

```text
locks/{workspaceId}/{lockKey}
```

Lock key rules:

- Repository jobs lock by `repositoryId`.
- Container jobs lock by `container-{containerId}`.

The lock contains:

- `jobId`
- `workerId`
- `expiresAt`

If a lock is held by another active job, the worker should requeue the job by
clearing the worker lease and setting a waiting message. Expired locks may be
recovered.

## Job States

Supported job states:

- `queued`
- `leased`
- `running`
- `completed`
- `failed`
- `cancelled`

Expected state transitions:

```text
queued -> leased -> running -> completed
queued -> leased -> running -> failed
queued -> leased -> running -> cancelled
queued -> cancelled
leased/running -> queued, when waiting for a lock
leased/running with expired lease -> leased by another worker
```

The worker should observe cancellation before execution and before final
completion. Active process interruption is an improvement target listed in final
notes.

## Repository Actions

Repository actions operate on records under:

```text
workspaces/{workspaceId}/repositories/{repositoryId}
```

Supported actions:

- `discover_branches`
- `sync`
- `read_compose`
- `deploy`
- `build`
- `stop`
- `tunnel_start`
- `tunnel_stop`

### Branch Discovery

The worker lists remote Git branches for the repository URL. If a credential is
configured, it decrypts and injects the token into the Git operation. Tokens
must not be logged.

Result updates:

- `availableBranches`
- `branchesUpdatedAt`

### Repository Sync

The worker clones or pulls the repository into its clone directory.

Requirements:

- Repository paths must be derived from a safe project name.
- The resolved path must stay inside the configured clone directory.
- Git credentials must be redacted from logs and errors.
- Branch selection should be honored when configured.

### Read Compose

For Compose repositories, the worker reads the configured Compose file and
stores its content on the repository record.

Requirements:

- Compose file path must be relative.
- Path traversal outside the repository must be blocked.
- File must exist.
- Content is limited to 1 MB.

Result update:

- `composeContent`

### Deploy and Build

Deployment behavior depends on repository mode.

Compose mode:

- Sync repository.
- Load workspace and repository environment values.
- Write a `.env` file.
- Generate an environment override file when needed.
- Run `docker compose -p {project} -f {composeFile} [-f {override}] up -d --build`.
- Optionally start public tunnels if public tunneling is enabled on the repository.

Dockerfile mode:

- Sync repository.
- Validate Dockerfile path.
- Load environment.
- Build an image tagged for the project.
- Replace the existing managed container.
- Run the container with configured ports and environment.
- Optionally start public tunnels if enabled.

### Stop

Compose mode stops the Compose stack. Dockerfile mode removes the managed
container. Both modes should clear public tunnel state.

### Public Tunnels

Public tunnels expose running repository services through ngrok or a compatible
tunnel provider.

Expected behavior:

- Resolve running target containers.
- Determine a target URL from host port mapping or container IP and internal port.
- Support one tunnel per Compose service.
- Support optional domain per repository or per service.
- Read repository-specific tunnel tokens from `secrets/ngrok`.
- Store `publicUrl`, `publicUrls`, `publicTunnels`, `publicTunnelStatus`,
  `publicTunnelTarget`, `publicTunnelWorkerId`, `publicTunnelWorkerLabel`, and
  `publicTunnelUpdatedAt`.
- Stop tunnels by repository prefix.
- Clear public URL state on stop.

## Container Actions

Supported container actions:

- `inventory_refresh`
- `container_start`
- `container_stop`
- `container_restart`
- `container_delete`
- `container_logs`
- `container_exec`

Behavior:

- Resolve containers by dashboard record ID, Docker ID, name, or container ref.
- Protect the worker container from stop, delete, and exec.
- Refresh container inventory after mutating actions.
- Store log tail for `container_logs`.
- Limit log output size.

`container_exec` runs a non-interactive shell command inside the target
container and publishes:

- `commandOutput`
- `commandExitCode`

Non-zero command exit codes should fail the job while preserving output.

## Worker Commands

`worker_command` runs a command on the worker host/container.

Behavior:

- If a repository is specified, use that repository clone as the working directory.
- If no repository is specified, use the worker clone root.
- Load workspace and repository environment when a repository is present.
- Normalize Compose exec commands to non-interactive mode.
- Enforce timeout limits.
- Publish `commandOutput` and `commandExitCode`.
- Fail the job when the exit code is non-zero.

Worker commands are powerful because the worker has Docker access. They should
be treated as privileged operations.

## Environment Loading

Environment values may come from:

- Workspace-level environment.
- Repository `environment`.
- Legacy repository `env` or `env_vars`.
- Imported JSON or text formats.

Expected behavior:

- Merge workspace values first.
- Merge repository values after workspace values.
- Repository values override workspace values.
- Accept object maps, JSON strings, dotenv-style text, and simple arrays where supported.
- Validate environment variable names.
- Strip null bytes.
- Preserve multiline values when possible.

Environment is used for Compose, Dockerfile containers, and repository-scoped
worker commands.

## Secret Handling

Secrets are stored outside normal workspace records under `secrets/...`.

Supported secret types:

- Git credentials under `secrets/credentials/{workspaceId}/{credentialId}`.
- Repository ngrok tokens under `secrets/ngrok/{workspaceId}/{repositoryId}`.

Requirements:

- Use AES-256-GCM compatible with the web application secret format.
- Never write decrypted secrets back to normal workspace records.
- Never log raw secrets.
- Prefer masked metadata in UI records.

## Error Handling

Worker errors should be compact and useful.

Expected behavior:

- Publish `failed` status with a message capped to a safe length.
- Preserve command output for command jobs.
- Delete failed queue items to avoid infinite immediate retries.
- Release locks after failure.
- Keep heartbeat alive after job failures.
- Redact credentials from Git and command output when possible.

Docker and Compose errors should be compacted to the most useful lines instead
of storing extremely long output.

## Security Boundaries

The worker is a high-trust component.

Important security facts:

- The worker usually mounts the Docker socket.
- Docker socket access is effectively host-level control.
- Repository builds can execute untrusted Dockerfiles, Compose files, and build scripts.
- Worker commands can run processes with the worker container's permissions.
- Container exec can access runtime secrets inside containers.
- Public tunnels expose internal services externally.
- Baked worker images may contain Firebase credentials and encryption keys.

The worker should be deployed only on trusted hosts and should operate trusted
repositories unless additional sandboxing or approval workflows are added.

## Language-Independent Module Model

Any implementation should provide these modules or equivalent responsibilities.

### Config Module

Loads environment, fallback config files, Firebase settings, worker paths,
pool/shard settings, Docker/ngrok settings, and runtime limits.

### Identity Module

Resolves stable worker ID, persists worker identity, generates claim tokens,
and computes claim token hashes.

### Firebase Client Module

Reads and writes Firebase records, supports conditional/transactional updates,
patches mirrored paths, and handles authentication using service-account
credentials.

### Heartbeat Module

Builds and publishes agent heartbeat records while preserving ownership and
sharing metadata.

### Queue Module

Scans/listens to queue shards, claims jobs, enforces concurrency, manages active
jobs, renews leases, publishes state, and deletes queue items.

### Lock Module

Acquires, renews, and releases repository/container locks.

### Docker Module

Collects Docker summary and inventory, performs container lifecycle actions,
reads logs, executes container commands, runs Dockerfile builds, and protects
worker containers.

### Git Module

Lists branches, clones repositories, pulls updates, checks out branches, and
redacts credentials.

### Executor Module

Maps job actions to repository/container/command/tunnel behavior and returns
dashboard-compatible messages and updates.

### Environment Module

Normalizes, validates, merges, and writes environment variables for deployment
and command execution.

### Secret Module

Decrypts credential and tunnel secrets using the shared encryption contract.

### Tunnel Module

Starts, tracks, stops, and reports public tunnels for repository services.

## Operational Limits

Current design limits:

- Compose file content returned to the dashboard is limited to 1 MB.
- Container logs and command output are truncated before storage.
- Commands must have bounded timeouts.
- Worker max concurrency limits simultaneous jobs per worker.
- Job leases and locks expire to allow recovery after worker crashes.
- Repository and file paths must remain inside configured worker directories.
- Worker containers cannot be stopped, deleted, or exec'd through the panel.

## Final Notes

Things still worth implementing or improving:

- Add active cancellation/interruption for running Docker, Compose, Git, ngrok,
  worker-command, and container-exec processes.
- Add a formal `docs/WORKER_RUNTIME_CONTRACT.md` with fixtures for every job
  action, success, failure, timeout, cancellation, and lease recovery case.
- Add automated parity tests that run the same Firebase job fixtures against
  every worker runtime.
- Add command allowlists or admin-managed command presets before treating
  arbitrary `worker_command` and `container_exec` as broadly safe.
- Add stronger audit logs for deploys, commands, sharing changes, worker claims,
  public tunnel opens, and credential usage.
- Add repository and worker allowlists so a worker owner can restrict what code
  may run on a host.
- Add Compose/Dockerfile policy scanning for privileged mode, host networking,
  host mounts, Docker socket mounts, and other high-risk settings.
- Add realtime queue listeners where unavailable, while keeping polling as a
  fallback.
- Add richer tunnel provider abstraction so ngrok is not the only public URL
  implementation.
- Add better stale tunnel reconciliation on worker restart.
- Add stronger secret-redaction for command output and deployment logs.
- Add production hardening for baked worker images, including safer defaults
  around `WORKER_BAKE_CONFIG`.
- Add runtime-specific publish commands for Python and Go worker images.
- Add live integration validation for deploy, tunnel, command, and inventory
  flows against a real workspace and Docker host.
