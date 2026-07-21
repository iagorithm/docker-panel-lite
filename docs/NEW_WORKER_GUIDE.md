# Run a New Worker

This guide explains how to start a new Docker Panel Lite worker on another
machine and claim it from the web UI.

## Requirements

The new machine needs:

- Docker Engine or Docker Desktop.
- Access to the private Docker image repository.
- Network access to Firebase.
- A user account in the Docker Panel Lite web UI at
  <https://v0-dpanel-c.vercel.app/>.

The published worker image must include its configuration. Confirm that it was
published with:

```env
WORKER_BAKE_CONFIG=true
```

The Docker Hub repository must remain private because the configured image
contains Firebase credentials.

## 1. Log In to Docker Hub

Log in with a Docker Hub user or access token that can pull the private image:

```bash
docker login
```

Pull the worker image:

```bash
docker pull cjarn/docker-panel-lite-worker:latest
```

If Docker reports `pull access denied`, verify that:

- The Docker Hub user has access to the private repository.
- The image exists under `cjarn/docker-panel-lite-worker`.
- `docker login` was completed on this machine.

## 2. Create Persistent Directories

Create one directory for cloned repositories and one for persistent worker
state:

```bash
mkdir -p docker-panel-worker/repos docker-panel-worker/data
cd docker-panel-worker
```

The `data` directory stores the worker ID and claim token. Do not delete it when
restarting, upgrading, or recreating the container.

Do not share the same `data` directory between different worker machines.

## 3. Start the Worker

Run the worker with access to the host Docker daemon:

```bash
docker run -d \
  --name docker-panel-lite-worker \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/repos:/app/clones" \
  -v "$PWD/data:/app/data" \
  cjarn/docker-panel-lite-worker:latest
```

No Firebase environment variables are required when the image was published
with `WORKER_BAKE_CONFIG=true`.

The Docker socket gives the worker control over Docker on this machine. Only run
an image from a trusted private repository.

## 4. Check Startup

Confirm that the container is running:

```bash
docker ps --filter name=docker-panel-lite-worker
```

Open its logs:

```bash
docker logs -f docker-panel-lite-worker
```

A healthy startup includes messages similar to:

```text
Worker claim token for worker-default-a1b2c3d4e5f6 (Mexica): <token>
Worker worker-default-a1b2c3d4e5f6 (Mexica) listening on pool=default
```

Keep the claim token private. It proves access to this worker installation.

Press `Ctrl+C` to stop following the logs. This does not stop the worker.

## 5. Claim the Worker

1. Open <https://v0-dpanel-c.vercel.app/> in the browser.
2. Sign in with an operator or administrator account.
3. Open **Containers** and select the **Workers** view.
4. Find the compact **Worker token** field.
5. Paste the token printed in the worker logs.
6. Select **Claim**.

The worker should show:

- An online status.
- Its generated worker name.
- A claimed state.
- The Docker host summary.
- Its current sharing mode.

Unclaimed workers are hidden from every user and can only be discovered by the
server through their claim token. A worker becomes visible to its owner after it
is claimed and starts as `Private`.

The owner can change access to:

- `Private`: only the owner can see and operate the worker.
- `Shared`: the owner and the email addresses entered in **Shared with** can see
  and operate it. Those users must sign in with the listed email address and
  belong to the same workspace.
- `Public`: every authenticated user in the same workspace can see and operate
  it.

## 6. Verify the Worker

Verify these items before deploying a repository:

1. The worker is online in the UI.
2. Its claim state is `claimed`.
3. Docker is shown as available.
4. The expected worker appears in repository worker selectors.
5. Repository action buttons become available after selecting it.

Run a small deployment or container log action to confirm that jobs are routed
to this worker and not to another machine.

## Optional Worker Settings

Runtime variables override values included in the image. They can be supplied
with `-e` when a machine needs a specific setting:

```bash
docker run -d \
  --name docker-panel-lite-worker \
  --restart unless-stopped \
  -e WORKER_LABEL=London \
  -e WORKER_LOCATION=Office-1 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/repos:/app/clones" \
  -v "$PWD/data:/app/data" \
  cjarn/docker-panel-lite-worker:latest
```

Common optional overrides are:

| Variable | Purpose |
| --- | --- |
| `WORKER_LABEL` | Preferred human-readable name |
| `WORKER_LOCATION` | Machine or site description |
| `WORKER_ID` | Explicit stable ID; normally leave unset |
| `WORKER_TOKEN` | Explicit claim token; normally leave unset |
| `WORKER_POOL` | Job queue pool, default `default` |
| `WORKER_MAX_CONCURRENCY` | Maximum simultaneous jobs |

If `WORKER_TOKEN` is not provided, the worker generates and persists a secure
token automatically.

## Restart the Worker

Restart without changing its identity:

```bash
docker restart docker-panel-lite-worker
```

Because the `data` directory remains mounted, the worker keeps the same worker
ID and claim token.

During a graceful restart, the UI may briefly show `stopping` before the worker
returns online.

## Update the Worker Image

Pull the new image:

```bash
docker pull cjarn/docker-panel-lite-worker:latest
```

Remove only the container, preserving the mounted directories:

```bash
docker stop docker-panel-lite-worker
docker rm docker-panel-lite-worker
```

Start it again with the same `docker run` command from step 3. The existing
`repos` and `data` directories preserve local state and worker identity.

## Stop the Worker

The UI intentionally does not stop worker containers because an offline worker
cannot start itself again. Stop it directly on its host when required:

```bash
docker stop docker-panel-lite-worker
```

The worker publishes `stopping` and then `offline` during a graceful shutdown.

Start it again with:

```bash
docker start docker-panel-lite-worker
```

## Remove a Worker Permanently

Stop and remove the local container:

```bash
docker stop docker-panel-lite-worker
docker rm docker-panel-lite-worker
```

Remove its record from the Workers UI after it is detected as offline and the
delete action becomes available.

Only delete the local `data` directory when the worker will never be restored.
Deleting it removes the persisted worker ID and claim token. A future start may
register as a different worker.

## Troubleshooting

### The worker exits immediately

Inspect the logs:

```bash
docker logs docker-panel-lite-worker
```

Common causes are an image published without baked configuration, invalid
Firebase service account JSON, a missing Firebase Database URL, or a missing
encryption key.

Republish the private image and confirm the publishing output says:

```text
baked config: yes
```

### The worker cannot access Docker

Confirm that the socket exists:

```bash
ls -l /var/run/docker.sock
```

Confirm that the container received the mount:

```bash
docker inspect docker-panel-lite-worker
```

On Docker Desktop and compatible Linux installations, the standard socket mount
used in this guide should be available.

### The worker token changes after every restart

The `/app/data` mount is missing or not writable. Confirm that the run command
contains:

```text
-v "$PWD/data:/app/data"
```

### The worker does not appear in the UI

Check:

- The worker logs do not contain Firebase connection errors.
- The image uses the correct `WORKER_WORKSPACE_ID`.
- The UI is connected to the same Firebase project and workspace.
- The worker has network access to Firebase.

### The token does not claim a worker

Check that:

- The full token was copied without spaces or line breaks.
- The worker is registered in the current UI workspace.
- The token belongs to the current worker installation.
- The worker has sent a heartbeat after starting.

### The worker appears offline while the container is running

Review the logs for repeated heartbeat failures:

```bash
docker logs --tail 200 docker-panel-lite-worker
```

Verify Firebase connectivity and confirm that the container clock is accurate.

## Final Checklist

- The private worker image can be pulled.
- The worker container is running with `--restart unless-stopped`.
- Docker socket, repositories, and data directories are mounted.
- Startup logs show a stable worker ID and claim token.
- The worker appears online in the UI.
- The worker is claimed by the correct user.
- Sharing is set to the intended mode.
- Docker is reported as available.
- A test job executes on the selected worker.
- Restarting the container preserves its identity and token.
