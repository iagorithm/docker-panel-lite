# Docker Panel Lite Go Worker

This is the Go implementation of the Docker Panel Lite worker. It is intended to run beside the existing Python worker and implement the same Firebase worker protocol.

Current implementation status:

- Loads the same worker environment variables as the Python worker.
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

Not implemented yet:

- Firebase realtime queue listeners. The Go worker currently uses polling.
- Active command cancellation/interruption after Docker or process execution has started.

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
./run.sh build-go
```

Build and run the local app with both Python and Go workers:

```bash
./run.sh up-go
```

Run only the Go worker service with Docker Compose:

```bash
docker compose --profile go-worker up worker-go
```

Use `run-local.sh` for the full local source stack:

```bash
./run-local.sh
```

The default `worker` service still runs the Python worker, and the local stack can run it beside `worker-go`. Keep using the Python worker for production deploy actions until the Go worker reaches full production parity.
