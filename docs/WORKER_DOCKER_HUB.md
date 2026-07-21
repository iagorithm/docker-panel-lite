# Worker Docker Hub Image

The worker can run from a prebuilt Docker Hub image on any machine that has Docker.
Workers are claimed and managed at <https://v0-dpanel-c.vercel.app/>.

For the complete new-machine setup and claim procedure, see
[`NEW_WORKER_GUIDE.md`](./NEW_WORKER_GUIDE.md).

## Publish

Set the image name in `.env`:

```env
WORKER_IMAGE=cjarn/docker-panel-lite-worker:py
WORKER_GO_IMAGE=cjarn/docker-panel-lite-worker:go
WORKER_IMAGE_PLATFORMS=linux/amd64,linux/arm64
```

Login and publish both runtime images:

```bash
docker login
./run.sh publish
```

This pushes:

```text
cjarn/docker-panel-lite-worker:py
cjarn/docker-panel-lite-worker:go
```

If Docker Hub rejects the push with `push access denied` or `insufficient_scope`, the logged-in user cannot write to the namespace in `WORKER_IMAGE`. Either create/grant access to that repository, or publish under a namespace you own:

```bash
WORKER_IMAGE=<your-dockerhub-user>/docker-panel-lite-worker:py ./run.sh publish
```

To publish a private image that already includes the worker Firebase configuration, set:

```env
WORKER_BAKE_CONFIG=true
```

This embeds values such as `FIREBASE_DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `CREDENTIAL_ENCRYPTION_KEY`, `WORKER_WORKSPACE_ID`, and ngrok defaults into the image. Use it only for a private Docker Hub repository.

To publish only one runtime:

```bash
./run.sh publish py
./run.sh publish go
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
  cjarn/docker-panel-lite-worker:py
```

If you prefer runtime configuration instead of a baked image, copy `.env.example` to `.env`, configure Firebase and encryption values, then start only the worker:

```bash
./run.sh run published worker
```

When the worker starts, it prints a claim token in its logs:

```text
Worker claim token for worker-default-... (Mexica): ...
```

Paste that token in the Workers tab to claim the worker. Unclaimed workers are hidden, and a newly claimed worker is private to its owner by default. The owner can later make it public or share it with specific email addresses. If you need to pin the token yourself, set `WORKER_TOKEN` in `.env`; otherwise it is generated once and stored in `./volume/data/worker-py/worker-token`.

The compose file mounts Docker and local worker state:

```yaml
/var/run/docker.sock:/var/run/docker.sock
./volume/repos/worker-py:/app/clones
./volume/data/worker-py:/app/data
```

Keep `./volume/data/worker-py` on the machine if you want the worker identity to remain stable.

## Local Development Build

Start the complete web and worker stack from local source without pulling the
published worker image:

```bash
./run.sh run
```

The script combines `docker-compose.yaml` with `docker-compose.build.yaml`, tags
the worker as `docker-panel-lite-worker:local`, builds both services, and starts
them in the background with the configured persistent mounts.

To build manually with the same Compose override:

```bash
./run.sh build
docker compose --env-file .env -f docker-compose.yaml -f docker-compose.build.yaml up -d worker
```
https://app.docker.com/settings
