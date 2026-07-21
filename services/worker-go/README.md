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
go run ./worker
```

Build:

```bash
cd services/worker-go
go build ./worker
```

Build with Docker:

```bash
docker compose -f docker-compose.build.yaml build worker-go
```

Build and run the local Go worker container with the app:

```bash
./run.sh up-go
```

Run only the Go worker service with Docker Compose:

```bash
docker compose --profile go-worker up worker-go
```

Use `run-local.sh` with the Go runtime:

```bash
WORKER_RUNTIME=go ./run-local.sh
```

The default `worker` service still runs the Python worker. Keep using the Python worker for production deploy actions until the Go worker implements queue leasing and executors.
