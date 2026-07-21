# Docker Control Panel

A Streamlit panel to clone GitHub repositories, build their images and run the
containers, plus manage existing containers.

## Architecture

The business logic is separated from the UI in the `core/` package, so `app.py`
is only the presentation layer (Streamlit):

```
app.py                 # UI flows and application shell (thin layer over core)
ui/
  components.py        # Accessible icon actions, status badges and headers
  styles.py            # Monochrome design system and responsive app shell
.streamlit/config.toml # Light grayscale theme tokens
core/
  git.py               # clone / pull / sync of repos (subprocess git)
  docker_ops.py        # build, compose up/down, container run
  store.py             # JSON persistence (repos, creds, admin) with error handling
  utils.py             # port/env parsing, token masking, validation
```

The interface uses a left-hand workspace navigation, searchable resource lists,
monochrome status treatments, and icon-only quick actions with text preserved
for assistive technologies and tooltips.

Benefits of this separation:
- **Maintainable**: each responsibility lives in a separately testable module.
- **Scalable**: adding new actions (e.g. `docker_ops.restart_stack`) only touches
  the UI where it is invoked.
- **Robust**: Docker/git/persistence errors are modeled as dedicated exceptions
  (`GitError`, `DockerUnavailableError`, `StoreError`) and the UI just displays them.

## What changed vs. the original version

- **Portainer-style login**: on first boot you create an admin user/password (stored
  salted+hashed in `data/admin.json`). Subsequent boots prompt for normal login. No
  hardcoded credentials.
- **Private GitHub cloning**: for a private repo, a Personal Access Token is requested
  and used only in memory for the `git clone` (never persisted to disk or the stored URL).
- **Real Build & Run**: each registered repo has a button that builds the image from the
  repo's `Dockerfile` (`docker.images.build`) and runs the container (`docker.containers.run`),
  replacing any previous container with the same name.
- **Configurable port mapping** per repo (`host:container`, comma separated).
- **Registered-repo persistence** in `data/repos.json` so they survive a panel restart.
- Mixed `subprocess docker ...` usage was replaced by a consistent Docker SDK (more reliable
  than shelling out to the CLI).
- Error handling on clone/build/Docker API instead of silent failures.

## Run locally

```bash
pip install -r requirements.txt
streamlit run app.py
```

You need `git` installed and access to the Docker socket (`/var/run/docker.sock`).

## Run in a container (recommended for production)

The panel needs access to the **host** Docker, so mount the socket:

```bash
docker build -t docker-control-panel .
docker run -d \
  --name docker-panel \
  -p 8501:8501 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/data:/app/data \
  docker-control-panel
```

- `data/` holds `admin.json` (panel credentials) and `repos.json` (registered repos) —
  mount it as a volume so they are not lost.
- By default repos are cloned into `/tmp/repos` inside the panel container; if you want
  them to persist across restarts, mount that path too or change `APP_CLONE_DIR`.

## Optional environment variables

| Variable | Description | Default |
|---|---|---|
| `APP_DATA_DIR` | Folder where `admin.json` and `repos.json` are stored | `data` |
| `APP_CLONE_DIR` | Folder where repos are cloned | `/tmp/repos` |

## Security notes

- The GitHub PAT for private repos is never written to `repos.json`; it is used only once
  for the initial `git clone`. To `pull` a private repo later, the token must still be valid
  in the remote URL configured by git (consider a GitHub App or a read-only token with expiry).
- Panel passwords are stored salted+hashed with SHA-256, not in plaintext.
- If you expose this panel outside your local network, put it behind HTTPS (reverse proxy) —
  Streamlit does not encrypt the login by itself.
