# Worker Docker Hub Image

The worker can run from a prebuilt Docker Hub image on any machine that has Docker.

## Publish

Set the image name in `.env`:

```env
WORKER_IMAGE=iagorithm/docker-panel-lite-worker:latest
WORKER_IMAGE_TAG=latest
WORKER_IMAGE_PLATFORMS=linux/amd64,linux/arm64
```

Login and publish:

```bash
docker login
./run.sh publish-worker
```

To publish an immutable version:

```bash
WORKER_IMAGE_TAG=2026-07-20 ./run.sh publish-worker
```

## Run On Another Machine

Copy `.env.example` to `.env`, configure Firebase and encryption values, then set:

```env
WORKER_IMAGE=iagorithm/docker-panel-lite-worker:latest
```

Start only the worker:

```bash
./run.sh pull worker
./run.sh up worker
```

The compose file mounts Docker and local worker state:

```yaml
/var/run/docker.sock:/var/run/docker.sock
./repos:/app/clones
./data:/app/data
```

Keep `./data` on the machine if you want the worker identity to remain stable.

## Local Development Build

Use the build override when you want to test local code instead of Docker Hub:

```bash
./run.sh build worker
docker compose --env-file .env -f docker-compose.yaml -f docker-compose.build.yaml up -d worker
```
