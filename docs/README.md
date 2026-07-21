# Docker Panel Lite

Quick commands for building, publishing, running locally, and running from a published worker image.

Run these commands from the repository root.

## Setup

```bash
cp .env.example .env
```

Fill `.env` with Firebase, encryption, Docker image, and worker settings.

## Build Local Images

Build the web app and Python worker from local source:

```bash
./run.sh build
```

Build the Go worker image from local source:

```bash
./run.sh build go
```

## Publish Worker Image

Log in to Docker Hub:

```bash
docker login
```

Set the image in `.env`:

```env
WORKER_IMAGE=your-dockerhub-user/docker-panel-lite-worker:py
WORKER_GO_IMAGE=your-dockerhub-user/docker-panel-lite-worker:go
WORKER_IMAGE_PLATFORMS=linux/amd64,linux/arm64
```

Build and push the worker image:

```bash
./run.sh publish
```

Verify the published image:

```bash
./run.sh verify
```

## Run Local Source Stack

Run the web app, Python worker, and Go worker from local source:

```bash
./run.sh run
```

Follow logs:

```bash
./run.sh logs
./run.sh logs-go
```

Stop the stack:

```bash
./run.sh down
```

## Run With Published Image

Pull and start the stack using the worker image configured in `.env`:

```bash
./run.sh run published
```

Run only the published worker image on another Docker host:

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

Read the claim token:

```bash
docker logs --tail 100 docker-panel-lite-worker
```

## Useful Commands

```bash
./run.sh ps
./run.sh restart
./run.sh scale-worker 2
./run.sh firebase-rules
```
