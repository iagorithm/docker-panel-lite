#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yaml"
COMPOSE_BUILD_FILE="$ROOT_DIR/docker-compose.build.yaml"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-docker-panel-lite}"
LOCAL_WORKER_IMAGE="${LOCAL_WORKER_IMAGE:-docker-panel-lite-worker:local}"
LOCAL_WORKER_GO_IMAGE="${LOCAL_WORKER_GO_IMAGE:-docker-panel-lite-worker-go:local}"

usage() {
  cat <<'EOF'
Docker Panel Lite command menu

Usage:
  ./run.sh <command> [args...]

Setup:
  setup                 Create .env from .env.example when missing
  firebase-rules        Deploy Firebase Realtime Database rules

Run:
  run                   Build and run local web + Python worker + logs app
  run local             Same as run
  run published         Pull/run stack using images configured in .env
  run go                Build/run web + Python worker + logs app + Go worker
  down                  Stop and remove stack containers
  restart               Recreate and start the published-image stack

Build and publish:
  build                 Build local web + Python worker images
  build all             Same as build
  build go              Build local Go worker image
  publish               Build and push Python (:py) and Go (:go) worker images
  publish py            Build and push only the Python worker image
  publish go            Build and push only the Go worker image
  verify                Inspect the published :py and :go worker images
  pull                  Pull configured service images

Observe and scale:
  ps                    Show service status
  logs [services...]    Follow logs, optionally for selected services
  logs-go               Follow Go worker logs
  scale-worker N        Run N Python worker replicas

Environment:
  Copy .env.example to .env and fill Firebase + encryption values first.
EOF
}

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing environment file: $ENV_FILE" >&2
    echo "Create it with: ./run.sh setup" >&2
    exit 1
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed or is not in PATH." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required: docker compose version" >&2
    exit 1
  fi
}

warn_missing_values() {
  local missing=0
  local required=(
    NEXT_PUBLIC_FIREBASE_API_KEY
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
    NEXT_PUBLIC_FIREBASE_DATABASE_URL
    NEXT_PUBLIC_FIREBASE_PROJECT_ID
    NEXT_PUBLIC_FIREBASE_APP_ID
    FIREBASE_DATABASE_URL
    FIREBASE_SERVICE_ACCOUNT_JSON
    CREDENTIAL_ENCRYPTION_KEY
  )

  for key in "${required[@]}"; do
    if ! grep -Eq "^${key}=.+" "$ENV_FILE"; then
      echo "Missing required value in .env: $key" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    echo "Fill the required values before starting the services." >&2
    exit 1
  fi
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_build() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$COMPOSE_BUILD_FILE" "$@"
}

compose_go() {
  docker compose --profile go-worker --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_local() {
  docker compose --profile go-worker --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$COMPOSE_BUILD_FILE" "$@"
}

env_value() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "$value" || ! -f "$ENV_FILE" ]]; then
    printf '%s' "$value"
    return
  fi
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

worker_image_ref() {
  local image
  image="$(env_value WORKER_IMAGE)"
  image="${image:-cjarn/docker-panel-lite-worker:py}"
  if [[ "$image" == *:* ]]; then
    printf '%s' "$image"
    return
  fi
  printf '%s:py' "$image"
}

prepare_runtime_dirs() {
  mkdir -p \
    "$ROOT_DIR/volume/data/worker-py" \
    "$ROOT_DIR/volume/repos/worker-py" \
    "$ROOT_DIR/volume/data/worker-go" \
    "$ROOT_DIR/volume/repos/worker-go"
}

cmd_setup() {
  if [[ -f "$ENV_FILE" ]]; then
    echo "Environment file already exists: $ENV_FILE"
    return
  fi
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Fill Firebase, encryption, and worker values before running the stack."
}

cmd_run() {
  local mode="${1:-local}"
  shift || true
  require_env_file
  require_docker
  warn_missing_values
  prepare_runtime_dirs
  case "$mode" in
    local)
      export WORKER_IMAGE="$LOCAL_WORKER_IMAGE"
      echo "Building and starting local source stack..."
      echo "  python worker image: $LOCAL_WORKER_IMAGE"
      echo "  services: web worker logs"
      compose_build up -d --build --pull never web worker logs "$@"
      compose_build ps web worker logs
      ;;
    published|image)
      echo "Starting stack from configured images..."
      compose pull "$@"
      compose up -d "$@"
      compose ps
      ;;
    go)
      export WORKER_IMAGE="$LOCAL_WORKER_IMAGE"
      export WORKER_GO_IMAGE="$LOCAL_WORKER_GO_IMAGE"
      echo "Building and starting stack with Go worker profile..."
      compose_local up -d --build --pull never web worker logs worker-go "$@"
      compose_go ps
      ;;
    *)
      echo "Unknown run mode: $mode" >&2
      echo "Use: ./run.sh run [local|published|go]" >&2
      exit 1
      ;;
  esac
}

cmd_build() {
  local target="${1:-all}"
  shift || true
  require_env_file
  require_docker
  warn_missing_values
  case "$target" in
    all|web|worker|python)
      compose_build build "$@"
      ;;
    go|worker-go)
      compose_go build worker-go "$@"
      ;;
    *)
      echo "Unknown build target: $target" >&2
      echo "Use: ./run.sh build [all|go]" >&2
      exit 1
      ;;
  esac
}

cmd_publish() {
  local target="${1:-all}"
  shift || true
  require_env_file
  require_docker
  case "$target" in
    all|both|py|python|go)
      "$ROOT_DIR/scripts/publish-worker-image.sh" "$target" "$@"
      ;;
    *)
      echo "Unknown publish target: $target" >&2
      echo "Use: ./run.sh publish [all|py|go]" >&2
      exit 1
      ;;
  esac
}

main() {
  local command="${1:-}"
  if [[ -z "$command" ]]; then
    usage
    exit 0
  fi
  shift || true

  case "$command" in
    help|-h|--help|menu)
      usage
      ;;
    setup|init)
      cmd_setup "$@"
      ;;
    run|local)
      if [[ "$command" == "local" ]]; then
        cmd_run local "$@"
      else
        cmd_run "$@"
      fi
      ;;
    up)
      cmd_run published "$@"
      ;;
    down)
      require_env_file
      require_docker
      compose down "$@"
      ;;
    restart)
      require_env_file
      require_docker
      warn_missing_values
      prepare_runtime_dirs
      compose up -d --force-recreate "$@"
      compose ps
      ;;
    ps)
      require_env_file
      require_docker
      compose ps "$@"
      ;;
    logs)
      require_env_file
      require_docker
      compose logs -f "$@"
      ;;
    logs-go)
      require_env_file
      require_docker
      compose_go logs -f worker-go "$@"
      ;;
    build)
      cmd_build "$@"
      ;;
    publish)
      cmd_publish "$@"
      ;;
    verify)
      require_env_file
      require_docker
      image_ref="$(worker_image_ref)"
      base_image="${image_ref%:*}"
      echo "Inspecting $base_image:py"
      docker buildx imagetools inspect "$base_image:py"
      echo
      echo "Inspecting $base_image:go"
      docker buildx imagetools inspect "$base_image:go"
      ;;
    pull)
      require_env_file
      require_docker
      compose pull "$@"
      ;;
    firebase-rules)
      firebase deploy --config "$ROOT_DIR/scripts/firebase.json" --only database "$@"
      ;;
    scale-worker)
      require_env_file
      require_docker
      warn_missing_values
      prepare_runtime_dirs
      local count="${1:-}"
      if [[ ! "$count" =~ ^[0-9]+$ ]] || [[ "$count" -lt 1 ]]; then
        echo "Usage: ./run.sh scale-worker N" >&2
        exit 1
      fi
      compose up -d --scale "worker=$count" worker
      compose ps
      ;;
    *)
      echo "Unknown command: $command" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
