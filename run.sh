#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yaml"
COMPOSE_BUILD_FILE="$ROOT_DIR/docker-compose.build.yaml"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-docker-panel-lite}"

usage() {
  cat <<'EOF'
Usage:
  ./run.sh [command]

Commands:
  up                  Pull and start the worker
  down                Stop and remove the stack containers
  restart             Restart the stack
  ps                  Show service status
  logs [services...]  Follow logs, optionally for selected services
  build               Build the worker image locally
  publish-worker      Build and push the worker image to Docker Hub
  pull                Pull service images
  scale-worker N      Run N worker replicas

Environment:
  Copy .env.example to .env and fill Firebase + encryption values first.
EOF
}

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing .env file: $ENV_FILE"
    echo "Create it with: cp .env.example .env"
    exit 1
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed or is not in PATH."
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required: docker compose version"
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
      echo "Missing required value in .env: $key"
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    echo "Fill the required values before starting the services."
    exit 1
  fi
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_build() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$COMPOSE_BUILD_FILE" "$@"
}

prepare_runtime_dirs() {
  mkdir -p "$ROOT_DIR/data/letsencrypt" "$ROOT_DIR/repos"
}

main() {
  local command="${1:-up}"
  shift || true

  case "$command" in
    help|-h|--help)
      usage
      ;;
    up)
      require_env_file
      require_docker
      warn_missing_values
      prepare_runtime_dirs
      compose up -d "$@"
      compose ps
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
    build)
      require_env_file
      require_docker
      warn_missing_values
      compose_build build "$@"
      ;;
    publish-worker)
      require_env_file
      require_docker
      "$ROOT_DIR/scripts/publish-worker-image.sh" "$@"
      ;;
    pull)
      require_env_file
      require_docker
      compose pull "$@"
      ;;
    scale-worker)
      require_env_file
      require_docker
      warn_missing_values
      prepare_runtime_dirs
      local count="${1:-}"
      if [[ ! "$count" =~ ^[0-9]+$ ]] || [[ "$count" -lt 1 ]]; then
        echo "Usage: ./run.sh scale-worker N"
        exit 1
      fi
      compose up -d --scale "worker=$count" worker
      compose ps
      ;;
    *)
      echo "Unknown command: $command"
      usage
      exit 1
      ;;
  esac
}

main "$@"
