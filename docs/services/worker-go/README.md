# Docker Panel Lite Go Worker

This is the Go implementation of the Docker Panel Lite worker. It is intended to run beside the existing Python worker and implement the same Firebase worker protocol.

The source layout follows the Python worker by responsibility and filename.
See [`../../../services/worker-go/worker/PARITY.md`](../../../services/worker-go/worker/PARITY.md) for the
Python ↔ Go file map and the rules for keeping future functionality comparable.

## Compiled configuration

The Go worker intentionally differs from the Python worker: it does not read
process environment variables or `.env` configuration at runtime. Edit
`services/worker-go/worker/environment.go` before compiling it. The selected
values become part of the binary.

Do not commit production credentials or publish a binary containing them to a
public registry. The generated worker ID and claim token may be left empty;
each installation will create and persist them under the configured data
directory.

Current implementation status:

- Loads its worker configuration from `worker/environment.go`, compiled into the binary.
- Resolves stable worker identity.
- Persists the worker claim token in `/app/data/worker-token`.
- Writes the SHA-256 worker token hash to Firebase.
- Sends online/offline heartbeats to `workspaces/{workspaceId}/agents/{workerId}`.
- Preserves owner and sharing metadata on heartbeat.
- Reports Docker availability and summary.
- Polls Firebase queue shards and leases jobs with conditional REST writes.
- Publishes container inventory to the dashboard.
- Handles `inventory_refresh`, `container_logs`, `container_start`, `container_stop`, `container_restart`, and `container_delete`.
- Handles `container_exec` and `worker_command`.
- Handles `discover_branches`, `sync`, `read_compose`, `deploy`, `build`, `stop`, `tunnel_start`, and `tunnel_stop` for repository jobs.
- Decrypts Firebase-stored Git credentials with the same AES-256-GCM format as the app.
- Opens public ngrok tunnels using the same repository secret path as the Python worker.
- Reports immutable build version, commit, and commit date in its heartbeat.

Not implemented yet:

- Firebase realtime queue listeners. The Go worker currently uses polling.
- Active cancellation for long Compose, Docker build, Git, and tunnel setup operations. `worker_command` and `container_exec` are interrupted while running.

Run locally:

```bash
cd services/worker-go
go run ./worker
```

Build:

```bash
cd services/worker-go
go build ./worker
```

Build with Docker:

```bash
./run.sh build go
```

Published builds inject `workerVersion`, `buildCommit`, and `buildDate` into the
binary. Set `WORKER_VERSION=v1.2.3` to report a release name; when it is empty,
the publication script uses the exact Git commit SHA. Direct local builds report
`dev`, `unknown`, and `unknown`.

Build and run the local app with both Python and Go workers:

```bash
./run.sh run go
```

Run only the Go worker service with Docker Compose:

```bash
docker compose --profile go-worker up worker-go
```

Use `run.sh` for the full local source stack:

```bash
./run.sh run
```

The default `worker` service still runs the Python worker, and the local stack can run it beside `worker-go`. Keep using the Python worker for production deploy actions until the Go worker reaches full production parity.
