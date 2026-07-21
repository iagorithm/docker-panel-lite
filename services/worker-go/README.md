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

Not implemented yet:

- Queue leasing.
- Repository sync/deploy.
- Container actions.
- Public tunnels.
- Worker/container command execution.

Run locally:

```bash
cd services/worker-go
go run ./cmd/worker
```

Build:

```bash
cd services/worker-go
go build ./cmd/worker
```

Build with Docker:

```bash
docker compose -f docker-compose.build.yaml build worker-go
```

Run only the Go worker with Docker Compose:

```bash
docker compose --profile go-worker up worker-go
```

The default `worker` service still runs the Python worker. Keep using the Python worker for production deploy actions until the Go worker implements queue leasing and executors.
