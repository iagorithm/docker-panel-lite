"""
# Docker Control Panel
----------------------
Streamlit panel for:
  - Admin account login / creation (Portainer-style flow: first boot creates
    an admin, subsequent boots prompt for login).
  - Storing reusable GitHub credentials (PAT) to clone private repos.
  - Cloning/updating GitHub repositories (public or private).
  - Building and deploying: a single Dockerfile (Docker SDK) or a full stack
    via Docker Compose (the `docker compose` CLI).
  - Managing existing containers grouped by Compose project.

Presentation layer: all business logic lives in `core/`.
Requires: streamlit, docker (SDK), git and the `docker compose` CLI installed,
plus access to the Docker socket (/var/run/docker.sock).
"""

from __future__ import annotations

import html
import json
import os
from pathlib import Path

import streamlit as st

from core import docker_ops, git, store, utils
from ui import components, styles

docker = docker_ops.docker

# --------------------------------------------------------------------------
# General configuration
# --------------------------------------------------------------------------
st.set_page_config(
    page_title="Container Control",
    page_icon=":material/deployed_code:",
    layout="wide",
    initial_sidebar_state="locked",
)
styles.apply_theme()

# --------------------------------------------------------------------------
# Paths / session state
# --------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("APP_DATA_DIR", "data"))
CLONE_DIR = Path(os.environ.get("APP_CLONE_DIR", "/tmp/repos"))
ADMIN_FILE = DATA_DIR / "admin.json"
REPOS_FILE = DATA_DIR / "repos.json"
CREDS_FILE = DATA_DIR / "github_credentials.json"

DATA_DIR.mkdir(parents=True, exist_ok=True)
if CLONE_DIR.exists() and not CLONE_DIR.is_dir():
    CLONE_DIR.unlink()
CLONE_DIR.mkdir(parents=True, exist_ok=True)


@st.cache_resource
def get_docker_client():
    return docker_ops.connect()


# --------------------------------------------------------------------------
# Authentication (Portainer-style flow: initial setup -> login)
# --------------------------------------------------------------------------
def setup_screen():
    with st.container(key="auth_shell"):
        st.markdown(
            """
            <div class="auth-intro">
                <div class="brand-mark brand-mark-large" aria-hidden="true"><span></span></div>
                <p class="eyebrow">Container Control</p>
                <h1>Set up your workspace</h1>
                <p class="auth-copy">Create the local administrator account used to protect this panel.</p>
            </div>
            """,
            unsafe_allow_html=True,
        )
        with st.form("setup_form"):
            username = st.text_input("Admin username", placeholder="admin")
            password = st.text_input("Password", type="password", placeholder="At least 8 characters")
            password2 = st.text_input("Confirm password", type="password", placeholder="Repeat your password")
            submitted = st.form_submit_button("Create workspace", type="primary", use_container_width=True)
            if submitted:
                if not username or not password:
                    st.error("Username and password are required")
                elif len(password) < 8:
                    st.error("Password must be at least 8 characters long")
                elif password != password2:
                    st.error("Passwords do not match")
                else:
                    store.save_admin(ADMIN_FILE, username, password)
                    st.session_state.authenticated = True
                    st.session_state.username = username
                    st.rerun()


def login_screen():
    with st.container(key="auth_shell"):
        st.markdown(
            """
            <div class="auth-intro">
                <div class="brand-mark brand-mark-large" aria-hidden="true"><span></span></div>
                <p class="eyebrow">Container Control</p>
                <h1>Welcome back</h1>
                <p class="auth-copy">Sign in to manage your local containers and deployments.</p>
            </div>
            """,
            unsafe_allow_html=True,
        )
        with st.form("login_form"):
            username = st.text_input("Username", placeholder="admin")
            password = st.text_input("Password", type="password")
            submitted = st.form_submit_button("Log in", type="primary", use_container_width=True)
            if submitted:
                if store.verify_login(ADMIN_FILE, username, password):
                    st.session_state.authenticated = True
                    st.session_state.username = username
                    st.rerun()
                else:
                    st.error("Incorrect username or password")


if "authenticated" not in st.session_state:
    st.session_state.authenticated = False

if not st.session_state.authenticated:
    if not store.admin_exists(ADMIN_FILE):
        setup_screen()
    else:
        login_screen()
    st.stop()

try:
    client = get_docker_client()
except docker_ops.DockerUnavailableError as e:
    st.error(
        f"Could not connect to the Docker daemon: {e}\n\n"
        "If the panel runs inside a container, mount the socket with "
        "`-v /var/run/docker.sock:/var/run/docker.sock`."
    )
    st.stop()


# --------------------------------------------------------------------------
# Load persistent state into the session
# --------------------------------------------------------------------------
def load_state():
    if "repos" not in st.session_state:
        try:
            st.session_state.repos = store.load_repos(REPOS_FILE)
        except store.StoreError as e:
            st.error(f"{e}")
            st.session_state.repos = {}
    if "credentials" not in st.session_state:
        try:
            st.session_state.credentials = store.load_credentials(CREDS_FILE)
        except store.StoreError as e:
            st.error(f"{e}")
            st.session_state.credentials = {}


load_state()


def resolve_token(info: dict) -> str:
    """Resolve the token from the stored credential associated with the repo."""
    cred_alias = info.get("credential", "")
    if not cred_alias:
        return ""

    credential = st.session_state.credentials.get(cred_alias)
    if not credential:
        raise git.GitError(
            f"GitHub credential '{cred_alias}' is not available. "
            "Assign an existing credential to this repository."
        )

    token = credential.get("token", "")
    if not token:
        raise git.GitError(f"GitHub credential '{cred_alias}' does not contain a token")
    return token


def _token_for_choice(cred_choice: str, one_off_token: str) -> str:
    """Token to use based on the add-repo form selection."""
    if cred_choice == "Public (no credential)":
        return ""
    if cred_choice == "Use a new token":
        return one_off_token
    return st.session_state.credentials.get(cred_choice, {}).get("token", "")


def _now() -> str:
    from datetime import datetime

    return datetime.now().isoformat()


def _environment_mapping(value: str) -> dict[str, str]:
    """Return stored KEY=VALUE lines as an ordered mapping."""
    mapping: dict[str, str] = {}
    for line in utils.parse_env(value):
        key, _, item_value = line.partition("=")
        mapping[key] = item_value
    return mapping


def _environment_rows(value: str) -> list[dict[str, str]]:
    """Return environment variables in the shape used by st.data_editor."""
    rows = [{"Key": key, "Value": item_value} for key, item_value in _environment_mapping(value).items()]
    return rows or [{"Key": "", "Value": ""}]


def _environment_from_rows(edited_rows) -> str:
    """Serialize edited Key/Value rows, rejecting incomplete or duplicate keys."""
    if hasattr(edited_rows, "to_dict"):
        rows = edited_rows.to_dict(orient="records")
    else:
        rows = list(edited_rows or [])

    variables: dict[str, str] = {}
    for row in rows:
        key = str(row.get("Key") or "").strip()
        item_value = str(row.get("Value") or "")
        if not key and not item_value:
            continue
        if not key:
            raise ValueError("Every environment value needs a key")
        if "=" in key or "\n" in key:
            raise ValueError(f"Invalid environment key: {key}")
        if key in variables:
            raise ValueError(f"Duplicate environment key: {key}")
        variables[key] = item_value
    return "\n".join(f"{key}={item_value}" for key, item_value in variables.items())


def _environment_from_json(value: str) -> str:
    """Serialize a small JSON object into Docker environment lines."""
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {e.msg}") from e
    if not isinstance(parsed, dict):
        raise ValueError("Environment JSON must be an object")

    rows: list[dict[str, str]] = []
    for key, item_value in parsed.items():
        if isinstance(item_value, (dict, list)):
            raise ValueError(f"Environment value for '{key}' must be scalar")
        rows.append({"Key": str(key), "Value": "" if item_value is None else str(item_value)})
    return _environment_from_rows(rows)


def _credentials_from_json(value: str) -> dict[str, dict[str, str]]:
    """Parse one credential or an alias-to-credential JSON object."""
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {e.msg}") from e
    if not isinstance(parsed, dict) or not parsed:
        raise ValueError("Credential JSON must be a non-empty object")

    if "token" in parsed:
        alias = str(parsed.get("name") or parsed.get("alias") or "").strip()
        entries = {alias: parsed}
    else:
        entries = parsed

    credentials: dict[str, dict[str, str]] = {}
    for raw_alias, raw_credential in entries.items():
        alias = str(raw_alias).strip()
        if not alias:
            raise ValueError("Every credential needs a name or alias")
        if not isinstance(raw_credential, dict):
            raise ValueError(f"Credential '{alias}' must be a JSON object")

        token = raw_credential.get("token")
        if not isinstance(token, str) or not token.strip():
            raise ValueError(f"Credential '{alias}' needs a token")
        username = raw_credential.get("username", "")
        if username is not None and not isinstance(username, str):
            raise ValueError(f"Username for credential '{alias}' must be text")

        credentials[alias] = {
            "username": (username or "").strip(),
            "token": token.strip(),
        }
    return credentials


# --------------------------------------------------------------------------
# Presentation helpers
# --------------------------------------------------------------------------
def _safe(value) -> str:
    return html.escape(str(value if value not in (None, "") else "—"), quote=True)


def _read_compose_source(repo_path: str, compose_file: str, max_bytes: int = 1_000_000) -> str:
    """Read a repository-local Compose file without allowing path traversal."""
    if not utils.validate_relative_file_path(compose_file):
        raise ValueError("Compose file must be a path relative to the repository root")

    repository_root = Path(repo_path).resolve()
    source_path = (repository_root / compose_file).resolve()
    try:
        source_path.relative_to(repository_root)
    except ValueError as e:
        raise ValueError("Compose file resolves outside the repository") from e

    if not source_path.is_file():
        raise FileNotFoundError(f"Compose file not found: {compose_file}")
    if source_path.stat().st_size > max_bytes:
        raise ValueError("Compose file is too large to display")
    try:
        return source_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as e:
        raise ValueError(f"Could not read Compose file: {e}") from e


def _image_label(container) -> str:
    try:
        return container.image.tags[0] if container.image.tags else container.image.short_id
    except Exception:  # noqa: BLE001 - stale Docker objects may fail to hydrate.
        return "—"


def _list_containers() -> list:
    try:
        return client.containers.list(all=True)
    except docker.errors.APIError as e:
        st.error(f"Could not list Docker containers: {e}")
        return []


def _request_confirmation(action: str, target: str) -> None:
    st.session_state.pending_confirmation = {"action": action, "target": target}


def _is_confirming(action: str, target: str) -> bool:
    pending = st.session_state.get("pending_confirmation", {})
    return pending.get("action") == action and pending.get("target") == target


def _clear_confirmation() -> None:
    st.session_state.pop("pending_confirmation", None)


def _render_empty_state(title: str, copy: str) -> None:
    st.markdown(
        f"""
        <div class="empty-state">
            <div class="empty-state-icon" aria-hidden="true"><span></span></div>
            <h3>{_safe(title)}</h3>
            <p>{_safe(copy)}</p>
        </div>
        """,
        unsafe_allow_html=True,
    )


def _render_sidebar() -> str:
    with st.sidebar:
        st.markdown(
            """
            <div class="brand-lockup">
                <div class="brand-mark" aria-hidden="true"><span></span></div>
                <div><strong>Control</strong><span>Container workspace</span></div>
            </div>
            <p class="sidebar-label">Workspace</p>
            """,
            unsafe_allow_html=True,
        )
        page = st.radio(
            "Workspace",
            ("Containers", "Repositories"),
            key="workspace_page",
            label_visibility="collapsed",
        )
        st.divider()
        user_col, logout_col = st.columns([4, 1])
        user_col.markdown(
            f'<div class="session-user"><span aria-hidden="true"></span><div><small>Signed in</small><strong>{_safe(st.session_state.username)}</strong></div></div>',
            unsafe_allow_html=True,
        )
        with logout_col:
            if components.icon_button(
                "Log out",
                key="icon_action_logout",
                icon="logout",
                help="Log out",
            ):
                st.session_state.authenticated = False
                st.rerun()
    return page


# --------------------------------------------------------------------------
# Containers
# --------------------------------------------------------------------------
def _render_container_row(container) -> None:
    is_running = container.status == "running"
    container_key = container.id[:12]
    error_key = f"container_error_{container_key}"
    project = container.labels.get("com.docker.compose.project", "")
    identity_detail = _image_label(container)
    if project and project != container.name:
        identity_detail = f"{identity_detail} · {project}"
    with st.container(key=f"container_card_{container_key}"):
        identity_col, status_col, actions_col = st.columns(
            [5.2, 1.5, 3.3],
            vertical_alignment="center",
        )
        identity_col.markdown(
            f"""
            <div class="resource-identity">
                <div class="resource-glyph" aria-hidden="true"><span></span></div>
                <div class="resource-copy">
                    <strong>{_safe(container.name)}</strong>
                    <span title="{_safe(identity_detail)}">{_safe(identity_detail)}</span>
                </div>
            </div>
            """,
            unsafe_allow_html=True,
        )
        with status_col:
            components.status_badge("Running" if is_running else "Stopped", running=is_running)

        with actions_col:
            with st.container(
                horizontal=True,
                horizontal_alignment="right",
                vertical_alignment="center",
                gap="xsmall",
            ):
                lifecycle_label = f"{'Stop' if is_running else 'Start'} {container.name}"
                if components.icon_button(
                    lifecycle_label,
                    key=f"icon_action_primary_lifecycle_{container_key}",
                    icon="stop" if is_running else "play_arrow",
                    help="Stop container" if is_running else "Start container",
                    primary=True,
                ):
                    try:
                        container.stop() if is_running else container.start()
                        st.session_state.pop(error_key, None)
                        st.rerun()
                    except docker.errors.APIError as e:
                        st.session_state[error_key] = f"Container action failed: {e}"
                        st.rerun()

                logs_open = st.session_state.get("open_container_logs") == container.id
                if components.icon_button(
                    f"{'Hide' if logs_open else 'View'} logs for {container.name}",
                    key=f"icon_action_logs_{container_key}",
                    icon="terminal",
                    help="Hide logs" if logs_open else "View logs",
                ):
                    st.session_state.open_container_logs = None if logs_open else container.id
                    st.rerun()

                if components.icon_button(
                    f"Restart {container.name}",
                    key=f"icon_action_restart_{container_key}",
                    icon="restart_alt",
                    help="Restart container",
                    disabled=not is_running,
                ):
                    try:
                        container.restart()
                        st.session_state.pop(error_key, None)
                        st.rerun()
                    except docker.errors.APIError as e:
                        st.session_state[error_key] = f"Could not restart container: {e}"
                        st.rerun()

                if components.icon_button(
                    f"Delete {container.name}",
                    key=f"icon_action_delete_{container_key}",
                    icon="delete_outline",
                    help="Delete container",
                ):
                    _request_confirmation("delete_container", container.id)
                    st.rerun()

        if st.session_state.get(error_key):
            st.error(st.session_state[error_key])

        if _is_confirming("delete_container", container.id):
            st.markdown(
                f'<div class="confirmation-copy"><strong>Delete {_safe(container.name)}?</strong><span>This force-removes the container and cannot be undone.</span></div>',
                unsafe_allow_html=True,
            )
            with st.container(horizontal=True, horizontal_alignment="right", gap="xsmall"):
                if st.button("Cancel", key=f"cancel_delete_container_{container_key}"):
                    _clear_confirmation()
                    st.rerun()
                if st.button(
                    "Delete container",
                    key=f"confirm_delete_container_{container_key}",
                    type="primary",
                ):
                    try:
                        container.remove(force=True)
                        _clear_confirmation()
                        st.rerun()
                    except docker.errors.APIError as e:
                        st.error(f"Could not delete container: {e}")

        if st.session_state.get("open_container_logs") == container.id:
            st.markdown('<p class="inline-label">Last 100 log lines</p>', unsafe_allow_html=True)
            try:
                log_text = container.logs(tail=100).decode(errors="replace")
            except docker.errors.APIError as e:
                log_text = f"Could not load logs: {e}"
            st.code(log_text or "No logs available.", language="text", line_numbers=False)


def _render_containers_page(containers: list) -> None:
    with st.container(
        horizontal=True,
        vertical_alignment="center",
        gap="xsmall",
        key="container_toolbar",
    ):
        query = st.text_input(
            "Search containers",
            placeholder="Search containers…",
            label_visibility="collapsed",
            key="container_search",
            persist_state="session",
            width="stretch",
        )
        if components.icon_button(
            "Refresh containers",
            key="icon_action_refresh_containers",
            icon="refresh",
            help="Refresh containers",
        ):
            st.rerun()

    normalized_query = query.strip().lower()
    if normalized_query:
        containers = [
            container
            for container in containers
            if normalized_query
            in " ".join(
                [
                    container.name,
                    _image_label(container),
                    container.labels.get("com.docker.compose.project", ""),
                ]
            ).lower()
        ]

    if not containers:
        if normalized_query:
            _render_empty_state("No matching containers", "Try another name, image, or Compose project.")
        else:
            _render_empty_state("No containers yet", "Run or deploy a repository to see it here.")
        return

    containers = sorted(
        containers,
        key=lambda container: (
            container.status != "running",
            container.labels.get("com.docker.compose.project", container.name).lower(),
            container.name.lower(),
        ),
    )
    with st.container(border=True, key="container_table"):
        for index, container in enumerate(containers):
            if index:
                st.markdown('<div class="container-row-divider" aria-hidden="true"></div>', unsafe_allow_html=True)
            _render_container_row(container)


# --------------------------------------------------------------------------
# Repositories
# --------------------------------------------------------------------------
def _run_pending_repo_action() -> None:
    pending = st.session_state.get("pending_action")
    if not pending:
        return

    action = pending.get("action", "")
    alias = pending.get("alias", "")
    info = st.session_state.repos.get(alias) if alias else None

    try:
        if action == "sync_all":
            _sync_all_repositories()
        elif not info:
            raise KeyError(f"Repository '{alias}' is no longer registered")
        elif action == "sync":
            with st.spinner(f"Syncing '{alias}'…"):
                git.sync_repo(
                    info["url"],
                    Path(info["path"]),
                    token=resolve_token(info),
                    timeout=300,
                    branch=info.get("branch", ""),
                )
            st.session_state[f"out_{alias}"] = ("success", f"'{alias}' is up to date", "")
        elif action == "build":
            deployment_branch = info.get("branch", "")
            if deployment_branch:
                with st.spinner(f"Syncing branch '{deployment_branch}' for '{alias}'…"):
                    git.sync_repo(
                        info["url"],
                        Path(info["path"]),
                        token=resolve_token(info),
                        timeout=300,
                        branch=deployment_branch,
                    )
            tag = f"{utils.sanitize_alias(alias).lower()}:latest"
            ports = utils.parse_ports(info.get("ports", ""))
            environment = utils.parse_env(info.get("env_vars", ""))
            with st.spinner(f"Building image for '{alias}'…"):
                short_id = docker_ops.build_and_run(
                    client,
                    info["path"],
                    info.get("dockerfile", "Dockerfile"),
                    tag,
                    alias,
                    ports,
                    environment,
                )
            st.session_state[f"out_{alias}"] = (
                "success",
                f"Container '{alias}' is running",
                f"Container ID: {short_id}",
            )
        elif action == "up":
            deployment_branch = info.get("branch", "")
            if deployment_branch:
                with st.spinner(f"Syncing branch '{deployment_branch}' for '{alias}'…"):
                    git.sync_repo(
                        info["url"],
                        Path(info["path"]),
                        token=resolve_token(info),
                        timeout=300,
                        branch=deployment_branch,
                    )
            compose_path = info.get("compose_file", "docker-compose.yml")
            env_lines = utils.parse_env(info.get("env_vars", ""))
            with st.spinner(f"Deploying '{alias}' with Docker Compose…"):
                result = docker_ops.compose_up(info["path"], alias, compose_path, env_lines, timeout=900)
            if result.ok:
                st.session_state[f"out_{alias}"] = ("success", f"Stack '{alias}' is running", result.stdout)
            else:
                st.session_state[f"out_{alias}"] = ("error", "Docker Compose deployment failed", result.stderr)
        elif action == "down":
            compose_path = info.get("compose_file", "docker-compose.yml")
            with st.spinner(f"Stopping and removing '{alias}'…"):
                result = docker_ops.compose_down(info["path"], alias, compose_path, timeout=300)
            if result.ok:
                st.session_state[f"out_{alias}"] = ("success", f"Stack '{alias}' stopped and removed", result.stdout)
            else:
                st.session_state[f"out_{alias}"] = ("error", "Docker Compose stop failed", result.stderr)
        else:
            raise ValueError(f"Unknown repository action: {action}")
    except Exception as e:  # noqa: BLE001 - surface operational failures in the full-width result area.
        if alias:
            action_name = {
                "sync": "Repository sync",
                "build": "Image build",
                "up": "Docker Compose deployment",
                "down": "Docker Compose stop",
            }.get(action, "Repository operation")
            st.session_state[f"out_{alias}"] = ("error", f"{action_name} failed", str(e))
        else:
            st.session_state.bulk_sync_notice = {"synced": 0, "failures": [str(e)]}
    finally:
        st.session_state.pop("pending_action", None)
    st.rerun()


def _sync_all_repositories() -> None:
    failures: list[str] = []
    synced = 0
    for alias, info in list(st.session_state.repos.items()):
        try:
            with st.spinner(f"Syncing '{alias}'…"):
                git.sync_repo(
                    info["url"],
                    Path(info["path"]),
                    token=resolve_token(info),
                    timeout=300,
                    branch=info.get("branch", ""),
                )
            synced += 1
        except git.GitError as e:
            failures.append(f"{alias}: {e}")
    st.session_state.bulk_sync_notice = {
        "synced": synced,
        "failures": failures,
    }


def _render_add_repository_panel() -> None:
    with st.expander("Register repository", expanded=True):
        mode_col, credential_col = st.columns(2)
        deploy_mode = mode_col.radio(
            "Deployment mode",
            ["Single Dockerfile", "Docker Compose"],
            horizontal=True,
            key="add_repo_mode",
            help="Use Docker Compose for repositories with multiple services.",
        )
        cred_options = ["Public (no credential)"] + list(st.session_state.credentials.keys()) + ["Use a new token"]
        cred_choice = credential_col.selectbox("GitHub credential", cred_options, key="cred_choice")

        one_off_token = ""
        save_new_cred = False
        new_cred_alias = ""
        if cred_choice == "Use a new token":
            token_col, save_col = st.columns([2, 1])
            one_off_token = token_col.text_input("Token (PAT)", type="password", key="one_off_token")
            save_new_cred = save_col.checkbox("Save for reuse", key="save_new_cred")
            if save_new_cred:
                new_cred_alias = st.text_input("Credential name", key="new_cred_alias")

        with st.form("add_repo_form"):
            url_col, branch_action_col = st.columns([10, 1])
            repo_url = url_col.text_input(
                "Repository URL",
                placeholder="https://github.com/user/repository.git",
                key="new_repo_url_input",
            )
            with branch_action_col:
                st.write("")
                with st.container(key="new_repo_branch_loader"):
                    load_branches = st.form_submit_button(
                        "Load branches",
                        icon=":material/account_tree:",
                        help="Load remote branches using the selected GitHub credential.",
                    )

            alias_col, branch_col = st.columns(2)
            repo_alias = alias_col.text_input("Display name", placeholder="my-service")
            cached_branch_url = st.session_state.get("new_repo_branch_url", "")
            cached_branch_credential = st.session_state.get("new_repo_branch_credential", "")
            remote_branches = (
                st.session_state.get("new_repo_remote_branches", [])
                if cached_branch_url == repo_url and cached_branch_credential == cred_choice
                else []
            )
            if remote_branches:
                repo_branch = branch_col.selectbox(
                    "Branch",
                    remote_branches,
                    key="new_repo_branch_select",
                    help="Remote branches available with the selected credential.",
                )
            else:
                repo_branch = branch_col.text_input(
                    "Branch",
                    placeholder="Default",
                    key="new_repo_branch_manual",
                )

            config_col, secondary_col = st.columns(2)
            if deploy_mode == "Single Dockerfile":
                dockerfile_path = config_col.text_input("Dockerfile", value="Dockerfile")
                port_mapping = secondary_col.text_input("Host:container ports", placeholder="8080:80")
                compose_file = ""
            else:
                compose_file = config_col.text_input("Compose file", value="docker-compose.yml")
                dockerfile_path = ""
                port_mapping = ""
                secondary_col.caption("Ports are read from the Compose file.")

            env_vars = st.text_area(
                "Environment variables",
                height=100,
                placeholder="PORT=8080\nDEBUG=true",
                help="Use KEY=VALUE, one per line. Values are injected at deploy time.",
            )
            with st.container(horizontal=True, horizontal_alignment="right", key="new_repo_submit"):
                submitted = st.form_submit_button(
                    "Clone and register",
                    type="primary",
                    icon=":material/download:",
                )

            if load_branches:
                if not utils.validate_repo_url(repo_url):
                    st.error("Enter a valid repository URL before loading branches")
                elif cred_choice == "Use a new token" and not one_off_token:
                    st.error("Enter a Personal Access Token before loading branches")
                else:
                    try:
                        remote_branches = git.list_remote_branches(
                            repo_url,
                            token=_token_for_choice(cred_choice, one_off_token),
                            timeout=30,
                        )
                    except git.GitError as e:
                        st.error(f"Could not load branches: {e}")
                    else:
                        if remote_branches:
                            st.session_state.new_repo_remote_branches = remote_branches
                            st.session_state.new_repo_branch_url = repo_url
                            st.session_state.new_repo_branch_credential = cred_choice
                            st.rerun()
                        else:
                            st.warning("The repository did not return any branches")
            elif submitted:
                if not repo_url or not repo_alias:
                    st.error("URL and display name are required")
                elif not utils.validate_repo_url(repo_url):
                    st.error("The URL must start with https://, git@, or ssh://")
                elif not utils.validate_branch_name(repo_branch):
                    st.error("Enter a valid Git branch name")
                elif deploy_mode == "Docker Compose" and not utils.validate_relative_file_path(compose_file):
                    st.error("Compose file must be a path relative to the repository root")
                elif cred_choice == "Use a new token" and not one_off_token:
                    st.error("Enter a Personal Access Token or choose another credential option")
                elif save_new_cred and not new_cred_alias:
                    st.error("Enter a name for the credential you want to save")
                elif save_new_cred and new_cred_alias in st.session_state.credentials:
                    st.error("A credential with that name already exists")
                else:
                    safe_alias = utils.sanitize_alias(repo_alias)
                    if not utils.is_safe_alias(safe_alias):
                        st.error("The display name must contain at least one letter or number")
                    elif safe_alias in st.session_state.repos:
                        st.error("A repository with that display name already exists")
                    else:
                        token = _token_for_choice(cred_choice, one_off_token)
                        repo_path = CLONE_DIR / safe_alias
                        try:
                            with st.spinner(f"Syncing '{safe_alias}'…"):
                                result = git.sync_repo(
                                    repo_url,
                                    repo_path,
                                    token=token,
                                    timeout=300,
                                    branch=repo_branch.strip(),
                                )
                            st.session_state.repos[safe_alias] = {
                                "url": repo_url,
                                "path": str(repo_path),
                                "mode": "compose" if deploy_mode == "Docker Compose" else "dockerfile",
                                "dockerfile": dockerfile_path or "Dockerfile",
                                "compose_file": compose_file or "docker-compose.yml",
                                "ports": port_mapping,
                                "branch": repo_branch.strip(),
                                "env_vars": env_vars or "",
                                "credential": (
                                    new_cred_alias
                                    if cred_choice == "Use a new token" and save_new_cred
                                    else (
                                        cred_choice
                                        if cred_choice not in ("Public (no credential)", "Use a new token")
                                        else ""
                                    )
                                ),
                                "added_at": _now(),
                            }
                            store.save_repos(REPOS_FILE, st.session_state.repos)

                            if save_new_cred and new_cred_alias and one_off_token:
                                st.session_state.credentials[new_cred_alias] = {
                                    "username": "",
                                    "token": one_off_token,
                                    "created_at": _now(),
                                }
                                store.save_credentials(CREDS_FILE, st.session_state.credentials)

                            st.session_state.bulk_sync_notice = {
                                "synced": 1,
                                "failures": [],
                                "message": f"Repository '{safe_alias}' {result.message.lower()}.",
                            }
                            st.session_state.repository_panel = None
                            st.rerun()
                        except git.GitError as e:
                            st.error(f"Git error: {e}")
                        except Exception as e:  # noqa: BLE001
                            st.error(f"Unexpected failure: {e}")


def _render_credentials_panel() -> None:
    with st.expander(f"Credentials  ·  {len(st.session_state.credentials)}", expanded=True):
        credential_input_mode = st.radio(
            "Credential input",
            ("Fields", "JSON"),
            horizontal=True,
            key="credential_input_mode",
            label_visibility="collapsed",
        )
        with st.form("add_credential_form", clear_on_submit=True):
            cred_alias = ""
            cred_username = ""
            cred_token = ""
            credential_json = ""
            if credential_input_mode == "Fields":
                alias_col, user_col = st.columns(2)
                cred_alias = alias_col.text_input("Credential name", placeholder="work")
                cred_username = user_col.text_input("GitHub username", placeholder="Optional")
                cred_token = st.text_input("Personal Access Token", type="password")
            else:
                credential_json = st.text_area(
                    "Credential JSON",
                    placeholder='{"name":"work", "username":"octocat", "token":"github_pat_..."}',
                    height=82,
                    key="credential_json_input",
                    help=(
                        "Add one credential with name, username and token, or multiple credentials "
                        "as an object keyed by alias."
                    ),
                )
            st.caption(
                "Need a token? [Generate a Personal Access Token on GitHub]"
                "(https://github.com/settings/tokens/new)."
            )
            submitted = st.form_submit_button(
                "Save credential" if credential_input_mode == "Fields" else "Import credential JSON",
                type="primary",
                use_container_width=True,
            )
            if submitted:
                try:
                    if credential_input_mode == "JSON":
                        imported_credentials = _credentials_from_json(credential_json)
                    else:
                        normalized_alias = cred_alias.strip()
                        normalized_token = cred_token.strip()
                        if not normalized_alias or not normalized_token:
                            raise ValueError("Name and token are required")
                        imported_credentials = {
                            normalized_alias: {
                                "username": cred_username.strip(),
                                "token": normalized_token,
                            }
                        }

                    duplicates = sorted(set(imported_credentials) & set(st.session_state.credentials))
                    if duplicates:
                        raise ValueError(f"Credential already exists: {', '.join(duplicates)}")

                    created_at = _now()
                    for alias, credential in imported_credentials.items():
                        st.session_state.credentials[alias] = {
                            **credential,
                            "created_at": created_at,
                        }
                    store.save_credentials(CREDS_FILE, st.session_state.credentials)
                except ValueError as e:
                    st.error(str(e))
                else:
                    st.rerun()

        if not st.session_state.credentials:
            st.caption("No saved credentials.")
            return

        for index, (alias, credential) in enumerate(list(st.session_state.credentials.items())):
            credential_key = f"{index}_{utils.sanitize_alias(alias) or 'credential'}"
            with st.container(border=True, key=f"credential_card_{credential_key}"):
                alias_col, user_col, token_col, action_col = st.columns(
                    [3, 2.4, 2.8, 0.8],
                    vertical_alignment="center",
                )
                alias_col.markdown(f'<div class="compact-title">{_safe(alias)}</div>', unsafe_allow_html=True)
                user_col.caption(credential.get("username") or "No username")
                token_col.markdown(
                    f'<code class="inline-token">{_safe(utils.mask_token(credential.get("token", "")))}</code>',
                    unsafe_allow_html=True,
                )
                with action_col:
                    if components.icon_button(
                        f"Delete credential {alias}",
                        key=f"icon_action_delete_credential_{credential_key}",
                        icon="delete_outline",
                        help="Delete credential",
                    ):
                        _request_confirmation("delete_credential", alias)
                        st.rerun()

                if _is_confirming("delete_credential", alias):
                    st.markdown(
                        f'<div class="confirmation-copy"><strong>Delete {_safe(alias)}?</strong><span>Repositories using it will no longer have an authentication token.</span></div>',
                        unsafe_allow_html=True,
                    )
                    with st.container(horizontal=True, horizontal_alignment="right", gap="xsmall"):
                        if st.button("Cancel", key=f"cancel_credential_{credential_key}"):
                            _clear_confirmation()
                            st.rerun()
                        if st.button(
                            "Delete credential",
                            key=f"confirm_credential_{credential_key}",
                            type="primary",
                        ):
                            del st.session_state.credentials[alias]
                            store.save_credentials(CREDS_FILE, st.session_state.credentials)
                            _clear_confirmation()
                            st.rerun()


def _render_repo_output(alias: str) -> None:
    output = st.session_state.get(f"out_{alias}")
    if not output:
        return
    kind, message, log = output
    message_col, dismiss_col = st.columns([9, 1])
    with message_col:
        st.success(message) if kind == "success" else st.error(message)
    with dismiss_col:
        if components.icon_button(
            f"Dismiss output for {alias}",
            key=f"icon_action_dismiss_output_{alias}",
            icon="close",
            help="Dismiss output",
        ):
            st.session_state.pop(f"out_{alias}", None)
            st.rerun()
    if log and log.strip():
        st.code(log, language="bash", line_numbers=False)


def _render_repository_card(alias: str, info: dict) -> None:
    info.setdefault("mode", "dockerfile")
    is_compose = info["mode"] == "compose"
    config_detail = (
        f"Compose · {info.get('compose_file', 'docker-compose.yml')}"
        if is_compose
        else f"{info.get('dockerfile', 'Dockerfile')} · Ports {info.get('ports') or '—'}"
    )
    config_detail = f"{config_detail} · Branch {info.get('branch') or 'default'}"
    with st.container(key=f"repo_card_{alias}"):
        identity_col, metadata_col, actions_col = st.columns(
            [3.2, 3.8, 3],
            vertical_alignment="center",
        )
        identity_col.markdown(
            f"""
            <div class="resource-identity">
                <div class="github-mark" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.84a7.65 7.65 0 0 1 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
                    </svg>
                </div>
                <div class="resource-copy">
                    <strong>{_safe(alias)}</strong>
                    <span>{'Docker Compose' if is_compose else 'Dockerfile'}</span>
                </div>
            </div>
            """,
            unsafe_allow_html=True,
        )
        metadata_col.markdown(
            f"""
            <div class="resource-metadata">
                <span title="{_safe(info.get('url'))}">{_safe(info.get('url'))}</span>
                <small title="{_safe(info.get('path'))}">{_safe(info.get('path'))}</small>
                <small title="{_safe(config_detail)}">{_safe(config_detail)}</small>
            </div>
            """,
            unsafe_allow_html=True,
        )

        with actions_col:
            with st.container(
                horizontal=True,
                horizontal_alignment="right",
                vertical_alignment="center",
                gap="xsmall",
            ):
                if components.icon_button(
                    f"Sync {alias}",
                    key=f"icon_action_sync_repo_{alias}",
                    icon="sync",
                    help="Clone or pull latest changes",
                ):
                    st.session_state.pending_action = {"action": "sync", "alias": alias}
                    st.rerun()

                if components.icon_button(
                    f"Edit settings for {alias}",
                    key=f"icon_action_edit_repo_{alias}",
                    icon="tune",
                    help="Edit repository settings",
                ):
                    st.session_state.editing_repo = alias
                    st.rerun()

                if is_compose:
                    if components.icon_button(
                        f"View Compose file for {alias}",
                        key=f"icon_action_view_compose_repo_{alias}",
                        icon="description",
                        help="View Docker Compose YAML",
                        primary=st.session_state.get("viewing_compose") == alias,
                    ):
                        st.session_state.viewing_compose = (
                            None if st.session_state.get("viewing_compose") == alias else alias
                        )
                        st.rerun()
                    if components.icon_button(
                        f"Deploy {alias}",
                        key=f"icon_action_primary_deploy_repo_{alias}",
                        icon="play_arrow",
                        help="Build and deploy stack",
                        primary=True,
                    ):
                        st.session_state.pending_action = {"action": "up", "alias": alias}
                        st.rerun()
                    if components.icon_button(
                        f"Stop and remove stack {alias}",
                        key=f"icon_action_stop_repo_{alias}",
                        icon="stop",
                        help="Stop and remove stack",
                    ):
                        _request_confirmation("down_repo", alias)
                        st.rerun()
                else:
                    if components.icon_button(
                        f"Build and run {alias}",
                        key=f"icon_action_primary_build_repo_{alias}",
                        icon="deployed_code",
                        help="Build image and run container",
                        primary=True,
                    ):
                        st.session_state.pending_action = {"action": "build", "alias": alias}
                        st.rerun()

                if components.icon_button(
                    f"Remove repository {alias}",
                    key=f"icon_action_delete_repo_{alias}",
                    icon="delete_outline",
                    help="Remove from the panel",
                ):
                    _request_confirmation("delete_repo", alias)
                    st.rerun()

        _render_repo_output(alias)

        if is_compose and st.session_state.get("viewing_compose") == alias:
            with st.container(key=f"compose_viewer_{alias}"):
                viewer_title_col, viewer_close_col = st.columns(
                    [9, 1],
                    vertical_alignment="center",
                )
                compose_file = info.get("compose_file", "docker-compose.yml")
                viewer_title_col.caption(f"Docker Compose · {compose_file}")
                with viewer_close_col:
                    if components.icon_button(
                        f"Close Compose viewer for {alias}",
                        key=f"icon_action_close_compose_repo_{alias}",
                        icon="close",
                        help="Close Compose viewer",
                    ):
                        st.session_state.viewing_compose = None
                        st.rerun()
                try:
                    compose_source = _read_compose_source(info.get("path", ""), compose_file)
                except (OSError, ValueError) as e:
                    st.warning(str(e))
                else:
                    st.code(
                        compose_source,
                        language="yaml",
                        line_numbers=True,
                        wrap_lines=True,
                        height=320,
                    )

        if _is_confirming("down_repo", alias):
            st.markdown(
                f'<div class="confirmation-copy"><strong>Stop {_safe(alias)}?</strong><span>Docker Compose will stop and remove the stack containers and networks.</span></div>',
                unsafe_allow_html=True,
            )
            with st.container(horizontal=True, horizontal_alignment="right", gap="xsmall"):
                if st.button("Cancel", key=f"cancel_down_{alias}"):
                    _clear_confirmation()
                    st.rerun()
                if st.button(
                    "Stop stack",
                    key=f"confirm_down_{alias}",
                    type="primary",
                ):
                    _clear_confirmation()
                    st.session_state.pending_action = {"action": "down", "alias": alias}
                    st.rerun()

        if _is_confirming("delete_repo", alias):
            st.markdown(
                f'<div class="confirmation-copy"><strong>Remove {_safe(alias)}?</strong><span>The clone stays on disk; only the panel registration is removed.</span></div>',
                unsafe_allow_html=True,
            )
            with st.container(horizontal=True, horizontal_alignment="right", gap="xsmall"):
                if st.button("Cancel", key=f"cancel_delete_repo_{alias}"):
                    _clear_confirmation()
                    st.rerun()
                if st.button(
                    "Remove repository",
                    key=f"confirm_delete_repo_{alias}",
                    type="primary",
                ):
                    del st.session_state.repos[alias]
                    store.save_repos(REPOS_FILE, st.session_state.repos)
                    _clear_confirmation()
                    st.rerun()

        if st.session_state.get("editing_repo") == alias:
            compose_file_value = info.get("compose_file", "docker-compose.yml") if is_compose else ""
            current_branch = info.get("branch") or ""
            try:
                available_branches = git.list_branches(Path(info.get("path", "")))
                branch_read_error = ""
            except git.GitError as e:
                available_branches = []
                branch_read_error = str(e)
            branch_options = [""] + available_branches
            if current_branch and current_branch not in branch_options:
                branch_options.append(current_branch)
            credential_options = [""] + list(st.session_state.credentials.keys())
            current_credential = info.get("credential") or ""
            if current_credential and current_credential not in credential_options:
                credential_options.append(current_credential)

            settings_columns = st.columns(3 if is_compose else 2, gap="small")
            branch_column_index = 1 if is_compose else 0
            credential_column_index = 2 if is_compose else 1
            if is_compose:
                with settings_columns[0]:
                    compose_file_value = st.text_input(
                        "Compose file",
                        value=compose_file_value,
                        key=f"compose_file_inline_{alias}",
                        help="Path relative to the repository root, for example deploy/compose.yml",
                    )
            with settings_columns[branch_column_index]:
                selected_branch = st.selectbox(
                    "Branch",
                    branch_options,
                    index=branch_options.index(current_branch),
                    format_func=lambda value: value or "Repository default",
                    key=f"branch_inline_{alias}",
                    help="Synchronized before each build or deployment.",
                )
                if branch_read_error:
                    st.caption(f"Could not read branches: {branch_read_error}")
            with settings_columns[credential_column_index]:
                selected_credential = st.selectbox(
                    "Credential",
                    credential_options,
                    index=credential_options.index(current_credential),
                    format_func=lambda value: (
                        "Public"
                        if not value
                        else (
                            value
                            if value in st.session_state.credentials
                            else f"{value} (missing)"
                        )
                    ),
                    key=f"credential_inline_{alias}",
                    help="Credential used to clone or pull this repository.",
                )

            environment_controls = st.columns([3, 1], gap="small")
            with environment_controls[0]:
                environment_mode = st.radio(
                    "Environment variables",
                    ("Key / value", "JSON"),
                    horizontal=True,
                    key=f"env_mode_inline_{alias}",
                    label_visibility="collapsed",
                )
            edited_environment_rows = None
            environment_json = ""
            edit_environment_json = False
            if environment_mode == "JSON":
                with environment_controls[1]:
                    edit_environment_json = st.toggle(
                        "Edit",
                        key=f"edit_env_json_inline_{alias}",
                        help="Switch between syntax-highlighted preview and source editing.",
                    )
            if environment_mode == "Key / value":
                edited_environment_rows = st.data_editor(
                    _environment_rows(info.get("env_vars", "")),
                    key=f"env_table_inline_{alias}",
                    column_config={
                        "Key": st.column_config.TextColumn("Key", required=True, width="medium"),
                        "Value": st.column_config.TextColumn("Value", width="large"),
                    },
                    hide_index=True,
                    num_rows="dynamic",
                    height=112,
                    width="stretch",
                )
            else:
                formatted_environment_json = json.dumps(
                    _environment_mapping(info.get("env_vars", "")),
                    ensure_ascii=False,
                    indent=2,
                )
                json_line_count = max(1, len(formatted_environment_json.splitlines()))
                json_widget_key = f"env_json_inline_{alias}"
                environment_json = st.session_state.get(json_widget_key, formatted_environment_json)
                if edit_environment_json:
                    environment_json = st.text_area(
                        "Environment JSON",
                        value=formatted_environment_json,
                        height=min(140, max(72, 28 + json_line_count * 13)),
                        key=json_widget_key,
                        label_visibility="collapsed",
                        placeholder='{"KEY": "value"}',
                    )
                else:
                    with st.container(key=f"env_json_preview_{alias}"):
                        st.code(
                            environment_json,
                            language="json",
                            line_numbers=True,
                            wrap_lines=True,
                            height=min(140, max(68, 24 + json_line_count * 13)),
                        )
            with st.container(horizontal=True, horizontal_alignment="right", gap="xsmall"):
                if components.icon_button(
                    f"Cancel settings for {alias}",
                    key=f"icon_action_cancel_settings_{alias}",
                    icon="close",
                    help="Cancel",
                ):
                    st.session_state.editing_repo = None
                    st.rerun()
                save_settings = components.icon_button(
                    f"Save settings for {alias}",
                    key=f"icon_action_save_settings_{alias}",
                    icon="check",
                    help="Save settings",
                    primary=True,
                )
                if save_settings:
                    if is_compose and not utils.validate_relative_file_path(compose_file_value):
                        st.error("Compose file must be a path relative to the repository root")
                    elif not utils.validate_branch_name(selected_branch):
                        st.error("Select a valid Git branch")
                    elif selected_credential and selected_credential not in st.session_state.credentials:
                        st.error("Select an existing GitHub credential")
                    else:
                        try:
                            env_text = (
                                _environment_from_rows(edited_environment_rows)
                                if environment_mode == "Key / value"
                                else _environment_from_json(environment_json)
                            )
                        except ValueError as e:
                            st.error(str(e))
                        else:
                            st.session_state.repos[alias]["env_vars"] = env_text
                            st.session_state.repos[alias]["credential"] = selected_credential
                            st.session_state.repos[alias]["branch"] = selected_branch
                            if is_compose:
                                st.session_state.repos[alias]["compose_file"] = compose_file_value.strip()
                            store.save_repos(REPOS_FILE, st.session_state.repos)
                            st.session_state.editing_repo = None
                            st.session_state[f"out_{alias}"] = (
                                "success",
                                f"Settings for '{alias}' saved",
                                "",
                            )
                            st.rerun()


def _render_repositories_page() -> None:
    _run_pending_repo_action()
    with st.container(
        horizontal=True,
        vertical_alignment="center",
        gap="xsmall",
        key="repository_toolbar",
    ):
        query = st.text_input(
            "Search repositories",
            placeholder="Search repositories…",
            label_visibility="collapsed",
            key="repository_search",
            persist_state="session",
            width="stretch",
        )
        repository_panel = st.session_state.get("repository_panel")
        if components.icon_button(
            "Register repository",
            key="icon_action_register_repository",
            icon="add",
            help="Register repository",
            primary=repository_panel == "register",
        ):
            st.session_state.repository_panel = None if repository_panel == "register" else "register"
            st.rerun()
        if components.icon_button(
            "Manage credentials",
            key="icon_action_manage_credentials",
            icon="key",
            help=f"Manage credentials · {len(st.session_state.credentials)}",
            primary=repository_panel == "credentials",
        ):
            st.session_state.repository_panel = None if repository_panel == "credentials" else "credentials"
            st.rerun()
        if components.icon_button(
            "Sync all repositories",
            key="icon_action_sync_all_repositories",
            icon="sync",
            help="Clone or pull all repositories",
            disabled=not st.session_state.repos,
        ):
            st.session_state.pending_action = {"action": "sync_all"}
            st.rerun()

    notice = st.session_state.pop("bulk_sync_notice", None)
    if notice:
        failures = notice.get("failures", [])
        if notice.get("message"):
            st.success(notice["message"])
        elif failures:
            st.error(f"Synced {notice['synced']} repositories; {len(failures)} failed.")
            with st.expander("View sync errors"):
                st.code("\n".join(failures), language="text", line_numbers=False)
        else:
            st.success(f"All {notice['synced']} repositories are up to date.")

    repository_panel = st.session_state.get("repository_panel")
    if repository_panel:
        with st.container(key="repository_controls"):
            if repository_panel == "register":
                _render_add_repository_panel()
            elif repository_panel == "credentials":
                _render_credentials_panel()

    if not st.session_state.repos:
        _render_empty_state("No repositories registered", "Add a GitHub repository to build or deploy it.")
        return

    normalized_query = query.strip().lower()
    repositories = [
        (alias, info)
        for alias, info in st.session_state.repos.items()
        if not normalized_query
        or normalized_query in " ".join([alias, info.get("url", ""), info.get("path", "")]).lower()
    ]
    if not repositories:
        _render_empty_state("No matching repositories", "Try another name, URL, or local path.")
        return

    with st.container(border=True, key="repository_table"):
        for index, (alias, info) in enumerate(repositories):
            if index:
                st.markdown('<div class="repository-row-divider" aria-hidden="true"></div>', unsafe_allow_html=True)
            _render_repository_card(alias, info)


# --------------------------------------------------------------------------
# Application shell
# --------------------------------------------------------------------------
all_containers = _list_containers()
active_page = _render_sidebar()

if active_page == "Containers":
    _render_containers_page(all_containers)
else:
    _render_repositories_page()
