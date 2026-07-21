# Worker Docker Hub Image

The worker can run from a prebuilt Docker Hub image on any machine that has Docker.
Workers are claimed and managed at <https://v0-dpanel-c.vercel.app/>.

For the complete new-machine setup and claim procedure, see
[`NEW_WORKER_GUIDE.md`](./NEW_WORKER_GUIDE.md).

## Publish

Set the image name in `.env`:

```env
WORKER_IMAGE=cjarn/docker-panel-lite-worker:latest
WORKER_IMAGE_TAG=latest
WORKER_IMAGE_PLATFORMS=linux/amd64,linux/arm64
```

Login and publish:

```bash
docker login
./run.sh publish-worker
```

If Docker Hub rejects the push with `push access denied` or `insufficient_scope`, the logged-in user cannot write to the namespace in `WORKER_IMAGE`. Either create/grant access to that repository, or publish under a namespace you own:

```bash
WORKER_IMAGE=<your-dockerhub-user>/docker-panel-lite-worker:latest ./run.sh publish-worker
```

To publish a private image that already includes the worker Firebase configuration, set:

```env
WORKER_BAKE_CONFIG=true
```

This embeds values such as `FIREBASE_DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `CREDENTIAL_ENCRYPTION_KEY`, `WORKER_WORKSPACE_ID`, and ngrok defaults into the image. Use it only for a private Docker Hub repository.

To publish an immutable version:

```bash
WORKER_IMAGE_TAG=2026-07-20 ./run.sh publish-worker
```

## Run On Another Machine

For a configured private image, the remote machine only needs Docker access to the image plus the Docker socket/data mounts:

```bash
docker run -d \
  --name docker-panel-lite-worker \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/repos:/app/clones" \
  -v "$PWD/data:/app/data" \
  cjarn/docker-panel-lite-worker:latest
```

If you prefer runtime configuration instead of a baked image, copy `.env.example` to `.env`, configure Firebase and encryption values, then start only the worker:

```bash
./run.sh pull worker
./run.sh up worker
```

When the worker starts, it prints a claim token in its logs:

```text
Worker claim token for worker-default-... (Mexica): ...
```

Paste that token in the Workers tab to claim the worker. New workers are public by default. If you need to pin the token yourself, set `WORKER_TOKEN` in `.env`; otherwise it is generated once and stored in `./data/worker-token`.

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
https://app.docker.com/settings
