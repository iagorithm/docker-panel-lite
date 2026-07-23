# Docker Panel Lite

Web control panel for managing Docker deployments from Git repositories, with production Python and Go workers connected through Firebase Realtime Database. An experimental Rust worker is being implemented under `services/worker-rust`.

## Main Commands

Run these commands from the repository root.

| Command | What it does |
| --- | --- |
| `./run.sh` | Shows the command menu. |
| `./run.sh setup` | Creates `.env` from `.env.example` when `.env` does not exist yet. |
| `./run.sh run` | Builds local source and starts `web`, Python `worker`, `logs`, and the independent CrewAI `logs-agent`. |
| `./run.sh run local` | Same as `./run.sh run`. |
| `./run.sh run published` | Pulls and starts the stack using the images configured in `.env`. Use this for the deployed worker image flow. |
| `./run.sh run go` | Starts the normal stack plus `worker-go`. |
| `./run.sh down` | Stops and removes the Compose stack containers. It does not delete local data under `volume/`. |
| `./run.sh restart` | Recreates and starts the published-image stack. |
| `./run.sh ps` | Shows Compose service status. |
| `./run.sh logs` | Follows logs for the main services. You can pass services, for example `./run.sh logs web worker`. |
| `docker compose build logs` | Builds only the independent Next.js error-log application. |
| `docker compose up -d logs` | Starts the error-log application on `${LOGS_PORT:-3001}`. Sign in through the main panel first. |
| `./run.sh logs-go` | Follows only the Go worker logs. |
| `./run.sh build` | Builds local images from `docker-compose.yaml` plus `docker-compose.build.yaml`. |
| `./run.sh build all` | Same as `./run.sh build`. |
| `./run.sh build go` | Builds only the local Go worker image. |
| `cd services/worker-go && go test ./...` | Runs all Go worker tests. |
| `bash scripts/check-worker-parity.sh` | Verifies that every shared Python worker module has its matching Go file. |
| `docker login` | Signs in to Docker Hub before publishing images. |
| `./run.sh publish` | Builds and pushes both worker images to Docker Hub: Python as `:py` and Go as `:go`. |
| `./run.sh publish py` | Builds and pushes only the Python worker image as `:py`. |
| `./run.sh publish go` | Builds and pushes only the Go worker image as `:go`. |
| `./run.sh verify` | Inspects the published `:py` and `:go` worker images. |
| `./run.sh pull` | Pulls the service images configured in `.env`. |
| `./run.sh scale-worker N` | Runs `N` Python worker replicas, for example `./run.sh scale-worker 2`. |
| `./run.sh firebase-rules` | Deploys Firebase Realtime Database rules from `scripts/database.rules.json`. |
| `docker logs --tail 100 docker-panel-lite-worker` | Reads the claim token when running a published worker with `docker run`. |

## Lint and Format the Next.js Apps

Run these commands from the repository root. They apply to both `apps/web` and
`apps/logs`.

Check the entire Next.js project with ESLint:

```bash
npm --prefix apps/web run lint
npm --prefix apps/logs run lint
```

Apply ESLint's automatic fixes:

```bash
npm --prefix apps/web run lint:fix
npm --prefix apps/logs run lint:fix
```

Format all supported files with Prettier:

```bash
npm --prefix apps/web run format
npm --prefix apps/logs run format
```

Check formatting without modifying files:

```bash
npm --prefix apps/web run format:check
npm --prefix apps/logs run format:check
```

Check TypeScript types without generating build files:

```bash
npm --prefix apps/web run typecheck
npm --prefix apps/logs run typecheck
```

## Build and Publish the Worker Image

Set the worker image in `.env`:

```env
WORKER_IMAGE=your-dockerhub-user/docker-panel-lite-worker:py
WORKER_GO_IMAGE=your-dockerhub-user/docker-panel-lite-worker:go
WORKER_IMAGE_PLATFORMS=linux/amd64,linux/arm64
```

Publish it:

```bash
docker login
./run.sh publish
./run.sh verify
```

## Run Locally

Run the web app, Python worker, and logs app from local source. The Go worker is
not started by this command:

```bash
./run.sh run
```

The error-log console is a separate Next.js application and Docker container:

```text
http://localhost:3001
```

It reads only Firebase `app_logs`, filters by date, worker, container or UI,
and downloads the selected errors to `app-logs.logs`. Downloading drains only
the selected records; browsing and refreshing never delete logs.

### Independent CrewAI logs agent

The agent implementation lives in `services/logs-agent`; it is not part of the
Next.js runtime. The logs UI sends authenticated requests through a thin server
proxy to `LOGS_AGENT_URL`. Locally this is the separate `logs-agent` container.

Configure these values in `.env` for local use and in the independent agent
deployment:

```env
OPENAI_API_KEY=...
CREWAI_MODEL=openai/gpt-5-mini
GITHUB_TOKEN=...
GITHUB_REPOSITORY=owner/repository
GITHUB_BASE_BRANCH=main
LOGS_AGENT_SECRET=a-long-random-shared-secret
```

In the Vercel project for `apps/logs`, configure only the service connection
and the existing Firebase Admin values:

```env
LOGS_AGENT_URL=https://your-independent-agent.example.com
LOGS_AGENT_SECRET=the-same-long-random-shared-secret
```

Analysis mode is read-only. Apply mode creates `logs-agent/<run-id>` from the
configured base branch and restricts all reads and writes to `services/**`.
Every run and commit is recorded under the workspace `agent_runs` collection.

Run the Go worker tests:

```bash
cd services/worker-go
go test ./...
```

Local persistent data is stored in:

```text
volume/data/worker-py
volume/repos/worker-py
volume/data/worker-go
volume/repos/worker-go
```

## Run With the Published Image

From this repository, using Compose:

```bash
./run.sh run published
```

On another machine, using only Docker:

```bash
mkdir -p "$HOME/docker-panel-worker/repos" "$HOME/docker-panel-worker/data"

docker run -d --pull always \
  --name docker-panel-lite-worker \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/docker-panel-worker/repos:/app/clones" \
  -v "$HOME/docker-panel-worker/data:/app/data" \
  --env-file .env \
  your-dockerhub-user/docker-panel-lite-worker:py
```

Then copy the claim token:

```bash
docker logs --tail 100 docker-panel-lite-worker
```

## More Documentation

Full documentation lives in [`docs/`](docs/).
