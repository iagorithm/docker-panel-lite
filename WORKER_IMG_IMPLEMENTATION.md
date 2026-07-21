# Worker Image and Claim Token Implementation

## Purpose

This document records everything implemented to package the worker as a
portable Docker image, run it on independent machines, register it safely in
Firebase, preserve its identity across restarts, and claim and manage it from
the web UI.

For the shorter machine setup runbook, see
[`NEW_WORKER_GUIDE.md`](./NEW_WORKER_GUIDE.md).

The implementation supports the following workflow:

1. Build one worker image for `linux/amd64` and `linux/arm64`.
2. Optionally include the Firebase and worker configuration in a private image.
3. Pull and run that image on another Docker host without copying the project.
4. Generate a stable worker identity and a persistent claim token.
5. Register the worker and its Docker inventory in Firebase.
6. Claim the hidden worker from the UI using the token shown in its local logs.
7. Select that worker when deploying repositories or operating containers.
8. Preserve ownership, sharing settings, status, and container records across
   heartbeats and restarts.

## Concepts

Three values identify different parts of a worker installation:

| Value | Purpose | Persistence |
| --- | --- | --- |
| Worker ID | Routes jobs and owns container records | `/app/data/worker-id` or a stable Docker host fingerprint |
| Worker claim token | Proves that an operator has access to the installation | `/app/data/worker-token` or `WORKER_TOKEN` |
| Worker label | Human-readable creative name shown in the UI | Preserved in the Firebase agent record |

The worker ID is not a secret. The claim token is a secret. Firebase stores only
the SHA-256 hash of the claim token.

## Implementation Map

| File | Implemented responsibility |
| --- | --- |
| `services/worker/Dockerfile` | Portable multi-architecture runtime image with Docker, Compose, ngrok, Python dependencies, worker code, and optional baked configuration |
| `scripts/publish-worker-image.sh` | Buildx builder setup, secret preparation, multi-platform build, push, verification, and actionable error output |
| `run.sh` | `build`, `publish-worker`, and `verify-worker-image` entry points |
| `docker-compose.yaml` | Runtime image, Docker socket, persistent data/repository mounts, and optional environment overrides |
| `docker-compose.build.yaml` | Local development build override |
| `services/worker/worker/config.py` | Baked environment loading, Firebase configuration resolution, host fingerprinting, and persistent worker identity |
| `services/worker/worker/main.py` | Claim token generation, hashing, worker registration, heartbeat lifecycle, stable labels, and Docker inventory publication |
| `apps/web/app/actions.ts` | Server-side claim validation, ownership updates, sharing updates, and worker deletion controls |
| `apps/web/app/dashboard/realtime-dashboard.tsx` | Worker claim form, sharing selector, worker state, ownership state, and runtime details |
| `apps/web/lib/types.ts` | Agent ownership, sharing, token hash, runtime, and lifecycle types |
| `.env.example` | Image publishing and worker configuration contract |
| `WORKER_DOCKER_HUB.md` | Operator-oriented build, publish, pull, and run instructions |

## 1. Portable Worker Image

The worker previously depended on the local source tree and runtime tools from
the host. The Dockerfile now creates a self-contained image based on
`python:3.12-slim`.

The image installs:

- Git and CA certificates for repository operations.
- Docker CLI for operating the host Docker daemon through its socket.
- Docker Compose v2 for Compose repository deployments.
- ngrok for per-container public tunnels.
- Python dependencies from `services/worker/requirements.txt`.
- Worker source code and helper scripts.

The architecture is selected through BuildKit's `TARGETARCH`. Download URLs are
mapped separately for `amd64`, `arm64`, and supported ARM variants because
Docker CLI, Compose, and ngrok use different architecture naming conventions.

The runtime command is:

```dockerfile
CMD ["python", "-m", "worker.main"]
```

The image also defines:

```text
WORKER_CONFIG_FILE=/app/config/worker.env
PYTHONUNBUFFERED=1
PYTHONDONTWRITEBYTECODE=1
```

Unbuffered output is required so worker activity and claim token logs appear
immediately in `docker logs`.

## 2. Multi-Architecture Build and Publishing

The publishing script builds these platforms by default:

```text
linux/amd64,linux/arm64
```

A normal Docker driver cannot export a multi-platform image directly. The
script therefore detects the selected Buildx driver and creates or selects a
`docker-container` builder named `docker-panel-lite-builder` when necessary.
It bootstraps the builder before starting the build.

The script supports:

- `WORKER_IMAGE` for the Docker Hub namespace and repository.
- `WORKER_IMAGE_TAG` for an immutable or release tag.
- `WORKER_IMAGE_PLATFORMS` for target platforms.
- `WORKER_BUILDX_BUILDER` for a custom builder name.
- `WORKER_BAKE_CONFIG` for optional embedded configuration.
- `PUSH=false` for a single-platform local validation build.
- `BUILDKIT_PROGRESS` for BuildKit output style.

It publishes both the configured tag and `latest`, then runs
`docker buildx imagetools inspect` to verify the remote manifest.

Several reliability fixes were required in this script:

- Empty BuildKit secret arrays are handled without triggering Bash
  `unbound variable` errors under `set -u`.
- The complete build command is assembled as a Bash array, preserving argument
  boundaries safely.
- Buildx selection, creation, and bootstrap failures produce explicit messages.
- The script prints a startup message before any operation, avoiding silent
  early exits.
- Unexpected failures report an approximate source line and exit code.
- Docker Hub `push access denied` and `insufficient_scope` failures produce
  namespace, repository, login, and organization-permission guidance.

The commands exposed through `run.sh` are:

```bash
./run.sh build worker
./run.sh publish-worker
./run.sh verify-worker-image
```

`build worker` only creates a local image. `publish-worker` is the command that
pushes the multi-platform manifest and layers to Docker Hub.

## 3. Optional Configuration Embedded in the Image

The worker can run in two configuration modes:

1. Runtime configuration supplied through environment variables.
2. Configuration embedded in a private image at build time.

Embedded configuration is enabled with:

```env
WORKER_BAKE_CONFIG=true
```

The publishing script reads the supported values from the active environment or
the project `.env`, writes them to a temporary file, and passes the file to the
Dockerfile as a BuildKit secret named `worker_config`.

The supported baked values currently include:

```text
FIREBASE_DATABASE_URL
NEXT_PUBLIC_FIREBASE_DATABASE_URL
NEXT_PUBLIC_FIREBASE_PROJECT_ID
FIREBASE_SERVICE_ACCOUNT_JSON
CREDENTIAL_ENCRYPTION_KEY
WORKER_WORKSPACE_ID
WORKER_POOL
WORKER_SHARDS
WORKER_MAX_CONCURRENCY
WORKER_LEASE_SECONDS
WORKER_POLL_SECONDS
QUEUE_SHARDS
TRAEFIK_ENABLED
TRAEFIK_NETWORK
NGROK_ENABLED
NGROK_AUTHTOKEN
NGROK_REGION
```

BuildKit prevents those values from being exposed as Docker build arguments or
printed as plain text in build output. The Dockerfile intentionally copies the
secret to `/app/config/worker.env` in the final image so it is available at
runtime.

This means the resulting image contains operational credentials. BuildKit
protects the build process, but it does not make the final image safe for public
distribution. A configured image must remain in a private registry repository.

The temporary build secret is removed after the publishing script exits.

## 4. Configuration Loading and Firebase JSON Support

`Settings.from_environment()` calls `_load_environment_file()` before reading
worker settings. The loader:

- Uses `WORKER_CONFIG_FILE`, defaulting to `/app/config/worker.env`.
- Ignores blank lines and comments.
- Accepts normal `KEY=value` entries.
- Removes matching single or double quotes.
- Validates environment variable names.
- Does not overwrite a non-empty runtime environment variable.

Runtime values therefore override baked values. This allows one image to carry
defaults while still permitting a machine-specific override.

Firebase service account credentials are accepted as JSON through
`FIREBASE_SERVICE_ACCOUNT_JSON`. They can also be loaded from
`FIREBASE_SERVICE_ACCOUNT_FILE` or `GOOGLE_APPLICATION_CREDENTIALS`.

The Firebase project ID is resolved from explicit project variables first and
then from the `project_id` field in the service account JSON. The Realtime
Database URL is resolved from its supported Firebase variables and validated
before the worker starts.

## 5. Runtime Mounts and Host Access

The worker needs three mounts:

```yaml
- /var/run/docker.sock:/var/run/docker.sock
- ./repos:/app/clones
- ./data:/app/data
```

Their responsibilities are:

| Mount | Responsibility |
| --- | --- |
| Docker socket | Inspect and operate containers on the worker machine |
| `/app/clones` | Persist cloned repositories used for Dockerfile and Compose deployments |
| `/app/data` | Persist worker ID, claim token, and other machine-local worker state |

The Compose environment section uses pass-through variable names instead of
`${VARIABLE:-}` substitutions. This prevents empty Compose defaults from
overwriting valid configuration embedded in the image.

The worker container uses `restart: unless-stopped` so it recovers automatically
after host or Docker daemon restarts.

## 6. Stable Worker Identity

The worker resolves its ID in this order:

1. Use `WORKER_ID` when explicitly configured.
2. Read a stable Docker host fingerprint and generate
   `worker-<pool>-<12-character-hash>`.
3. Reuse `/app/data/worker-id` when it exists.
4. Generate an ID from the hostname and a UUID, then persist it to
   `/app/data/worker-id`.
5. Use a temporary fallback ID only when persistent storage cannot be written.

The identity source is published to Firebase as `identitySource`, making it
possible to diagnose whether an ID came from an environment override, host
fingerprint, marker file, or fallback.

Persisting `./data` is essential. It prevents a recreated container from
appearing as a new orphan worker.

## 7. Stable Creative Worker Names

Each worker receives a human-readable label from the configured list of creative
place and culture names. The implementation:

- Reuses the existing Firebase label for the same worker ID.
- Honors `WORKER_LABEL` when explicitly provided.
- Selects the first unused name for a new worker.
- Adds a numeric suffix after exhausting the base name set.

Heartbeats preserve the selected label, so restarting the same worker does not
rename it.

## 8. Claim Token Generation and Persistence

`Worker.__init__` resolves the claim token before the first heartbeat.

The token resolution order is:

1. Use `WORKER_TOKEN` when explicitly configured.
2. Reuse `/app/data/worker-token` when present.
3. Generate a cryptographically random `secrets.token_urlsafe(24)` value.
4. Save the generated value to `/app/data/worker-token`.
5. Apply file mode `0600` when supported.
6. Fall back to an in-memory token if persistent storage cannot be written.

The in-memory fallback changes after every restart, which is why a writable and
persistent `/app/data` mount is required.

The worker calculates:

```text
SHA-256(claim token) -> workerTokenHash
```

Only `workerTokenHash` is sent to Firebase. The original token is never stored in
the agent record.

At startup, the local worker log displays the original token:

```text
Worker claim token for worker-default-<hash> (Mexica): <token>
```

This can be retrieved with:

```bash
docker logs docker-panel-lite-worker
```

`WORKER_TOKEN` is deliberately not included automatically in baked image
configuration. Every installation should normally generate its own token. An
explicit runtime `WORKER_TOKEN` remains available for controlled provisioning.

## 9. Firebase Worker Registration

Workers register under:

```text
workspaces/<workspaceId>/agents/<workerId>
```

The agent payload includes identity, routing, health, runtime, Docker, sharing,
and ownership information. A simplified record is:

```json
{
  "id": "worker-default-a1b2c3d4e5f6",
  "identitySource": "machine-id",
  "label": "Mexica",
  "hostname": "worker-host",
  "poolId": "default",
  "status": "online",
  "activeJobs": 0,
  "lastHeartbeat": 1784592000000,
  "workerTokenHash": "<sha256>",
  "sharing": "private",
  "shared": false,
  "public": false,
  "claimedAt": null,
  "claimedBy": "",
  "ownerUid": ""
}
```

Before creating each heartbeat payload, the worker reads its existing agent
record. It preserves fields owned by the UI:

```text
sharing
sharingUpdatedAt
sharingUpdatedBy
claimedAt
claimedBy
ownerUid
```

This prevents worker heartbeats from overwriting claim ownership or visibility
changes made by an operator.

Unclaimed workers are hidden from users. A successful first claim sets the
worker to `private`; the owner can later change it to `shared` or `public`.
Compatibility booleans are also maintained:

- `public` is true only for public workers.
- `shared` is true for shared and public workers.

## 10. Claiming a Worker from the UI

The Workers panel includes a compact `Worker token` form. Claiming is handled by
a server action rather than direct client-side Firebase access.

The claim flow is:

1. An authenticated operator copies the token from the worker's local logs.
2. The operator submits it through the Workers panel.
3. The server validates the input and requires at least eight characters.
4. The server computes SHA-256 using UTF-8 input.
5. It reads only the current workspace's agent records.
6. It finds a matching `workerTokenHash`. Legacy `claimTokenHash` is accepted for
   compatibility.
7. It updates `claimedAt`, `claimedBy`, and `ownerUid` with the authenticated
   user's ID.
8. A first claim assigns `private`; a repeat claim by the same owner preserves
   the current sharing mode.
9. A worker already owned by another user cannot be reclaimed with the token.

An invalid token returns without exposing whether a specific worker exists. The
plain token is not written to Firebase and is not returned to the browser after
submission.

The UI and TypeScript agent model were extended with:

```text
workerTokenHash
claimedAt
claimedBy
ownerUid
sharing
shared
public
sharingUpdatedAt
sharingUpdatedBy
```

The worker detail view displays its sharing mode,
identity source, host, pool, shards, runtime, Docker availability, timing,
Traefik state, and ngrok state.

The browser does not subscribe directly to the Firebase `agents` node. An
authenticated `/api/workers` endpoint reads agents with the Admin SDK, applies
the access policy, removes claim-token hashes, and returns only visible workers.
The dashboard refreshes this filtered snapshot periodically.

Realtime Database rules deny direct client reads of `agents`. Other workspace
collections retain their authenticated workspace reads, while all agent
visibility decisions are made by the server API. Deploy the updated rules with:

```bash
firebase deploy --only database
```

## 11. Worker Sharing Modes

An operator can change a worker to one of three modes:

| Mode | Stored values |
| --- | --- |
| Public | `sharing=public`, `public=true`, `shared=true` |
| Shared | `sharing=shared`, `public=false`, `shared=true`, plus `sharedEmails` |
| Private | `sharing=private`, `public=false`, `shared=false` |

The server records who changed sharing and when. The worker heartbeat preserves
those fields instead of resetting them.

Only `ownerUid` can change sharing. Shared email addresses are normalized to
lowercase and validated by the server. Claiming assigns ownership and makes a
new worker private by default. Shared users must authenticate with one of the
configured email addresses and belong to the same workspace as the worker.

## 12. Worker Lifecycle and Availability

On startup, the worker:

1. Resolves its configuration, identity, label, and token.
2. Logs the claim token locally.
3. Sends an initial `online` heartbeat.
4. Resets its Firebase container inventory to the Docker containers that really
   exist on that host.
5. Starts periodic heartbeats, Firebase queue listeners, and job polling.

During operation, the heartbeat updates:

- `lastHeartbeat`.
- Worker status and active job count.
- Docker server availability and version.
- Running and total container counts.
- Runtime and platform metadata.

On a graceful termination signal, the worker publishes `stopping` immediately.
After shutdown it publishes `offline`. If the machine disappears abruptly, the
UI derives offline state from an expired `lastHeartbeat`.

Worker-level exception boundaries keep scan, heartbeat, inventory, and job
failures visible in logs without terminating the main worker loop.

## 13. Worker-Owned Containers and Jobs

Container records include the worker ID and the real Docker container ID. Jobs
target a specific worker through `targetWorkerId` instead of being executed by
any worker that happens to receive them.

The server verifies that the selected worker is online before creating or
executing worker-dependent operations. If no worker is selected or the selected
worker is unavailable, deployment and container actions fail promptly instead
of leaving an indefinite UI spinner.

On startup, each worker reconciles only its own inventory. It removes stale
records belonging to that worker and publishes the containers that actually
exist on its Docker host. Other workers' records are not overwritten.

Container state is constrained by worker state:

- A container cannot be presented as running when its worker is stopping or
  offline.
- Logs, restart, terminal execution, and other runtime actions require an online
  worker and a running container.
- The worker's own container cannot be stopped or deleted from the UI; it can
  only be restarted or inspected through logs.

## 14. Running the Image on Another Machine

For a configured private image, the remote machine only needs Docker registry
access and the required mounts:

```bash
docker login
docker pull cjarn/docker-panel-lite-worker:latest

docker run -d \
  --name docker-panel-lite-worker \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/repos:/app/clones" \
  -v "$PWD/data:/app/data" \
  cjarn/docker-panel-lite-worker:latest
```

After startup:

```bash
docker logs docker-panel-lite-worker
```

The operator copies the displayed token and claims the worker from the Workers
panel. No Firebase variables are required in `docker run` when the image was
published with `WORKER_BAKE_CONFIG=true`.

## 15. Token Rotation and Recovery

A managed token can be supplied explicitly:

```env
WORKER_TOKEN=<secure-random-token>
```

Changing `WORKER_TOKEN` publishes a new `workerTokenHash` on the next heartbeat.
Existing `claimedAt`, `claimedBy`, and `ownerUid` values are intentionally
preserved. Token rotation does not automatically remove the current owner.

Deleting `/app/data/worker-token` causes a new token to be generated on restart.
Deleting `/app/data/worker-id` may also create a new worker record when a stable
Docker host fingerprint cannot be obtained.

Operational rules:

- Always persist `/app/data`.
- Do not share one data directory between different machines.
- Use `WORKER_ID` only when identity must be explicitly controlled.
- Delete only offline worker records that will not reconnect.
- Treat the token as a local provisioning secret.

## 16. Docker Hub Requirements and Failure Modes

Publishing requires all of the following:

- Docker Hub authentication through `docker login`.
- A repository matching the namespace in `WORKER_IMAGE`.
- Write access for the authenticated user.
- Organization write permission when the namespace belongs to an organization.
- A private repository when `WORKER_BAKE_CONFIG=true`.

This error occurs after a successful build when registry authorization is
missing:

```text
push access denied, repository does not exist or may require authorization
insufficient_scope: authorization failed
```

It does not indicate a Dockerfile or multi-platform build failure. The fix is to
create the repository, authenticate with the correct Docker Hub account or
token, grant write access, or change `WORKER_IMAGE` to a namespace owned by the
authenticated user.

## 17. Security Considerations

- Firebase stores only the claim token hash, never the original token.
- The original token is stored locally in `/app/data/worker-token` and protected
  with mode `0600` when the filesystem supports it.
- The token is printed on every worker startup. Anyone with local log access can
  obtain it.
- A generated token has sufficient entropy for hash-based lookup; operators
  should not replace it with a short human password.
- Claim lookup is limited to the authenticated user's workspace.
- Claiming requires an authenticated operator session.
- The Docker socket grants the worker control over the host Docker daemon and
  must be treated as privileged access.
- A baked image contains Firebase service account JSON and encryption material.
  Anyone who can pull the image can extract `/app/config/worker.env`.
- BuildKit secrets prevent accidental build-log disclosure, but they do not
  encrypt files copied into the final image.
- Private registry access and image pull permissions are part of the security
  boundary.

## 18. Validation Performed

The implementation was validated with:

- Python compilation checks for worker configuration and runtime modules.
- Next.js/Docker web builds after adding claim and sharing actions and types.
- Worker image builds through the Compose development override.
- A local single-platform `publish-worker` test with `PUSH=false`.
- A multi-platform Buildx build reaching the Docker Hub push stage for both
  `amd64` and `arm64`.
- BuildKit secret validation confirming that configuration values are not
  printed in build output.
- Shell syntax checks for `run.sh` and `publish-worker-image.sh`.
- Git whitespace validation for the publishing script.

A successful remote publication ends with:

```text
Pushed:
  cjarn/docker-panel-lite-worker:<tag>
  cjarn/docker-panel-lite-worker:latest
```

The remote manifest can be checked with:

```bash
./run.sh verify-worker-image
```

## 19. End-to-End Acceptance Checklist

1. `./run.sh publish-worker` reports `baked config: yes` for the private image.
2. Docker Hub contains both `linux/amd64` and `linux/arm64` manifests.
3. A clean remote machine can pull and start the image.
4. The worker starts without external Firebase environment variables.
5. Logs display one worker ID, stable label, and claim token.
6. Firebase receives the agent in the expected workspace.
7. The worker remains hidden until claimed, then appears private to its owner.
8. Submitting the token associates `ownerUid`, `claimedBy`, and `claimedAt`.
9. Sharing changes survive subsequent heartbeats.
10. A selected worker can execute repository and container jobs on its own host.
11. Restarting the worker preserves its ID, label, token, and ownership.
12. Graceful shutdown transitions through `stopping` to `offline`.
13. Abrupt host loss becomes offline after the heartbeat timeout.
14. Reconnection reconciles that worker's real Docker inventory without
    overwriting another worker's records.

## 20. Deployment Requirements for Worker Access Control

The access-control release has two independent deployment units:

1. Deploy the updated Next.js application so `/api/workers`, filtered dashboard
   state, atomic claiming, and server action authorization are active.
2. Deploy `database.rules.json` so browsers can no longer read the raw `agents`
   collection directly.

The Firebase rules command is:

```bash
firebase deploy --only database
```

The worker image must also be rebuilt and published because the worker now
preserves `ownerEmail` and `sharedEmails` during heartbeat updates:

```bash
./run.sh publish-worker
```
