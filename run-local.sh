#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yaml"
COMPOSE_BUILD_FILE="$ROOT_DIR/docker-compose.build.yaml"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-docker-panel-lite}"
LOCAL_WORKER_IMAGE="${LOCAL_WORKER_IMAGE:-docker-panel-lite-worker:local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE" >&2
  echo "Create it with: cp .env.example .env" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or is not available in PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/repos" "$ROOT_DIR/data" "$ROOT_DIR/data/letsencrypt"

# Override a Docker Hub image configured in .env with an explicitly local tag.
export WORKER_IMAGE="$LOCAL_WORKER_IMAGE"

compose=(
  docker compose
  --project-name "$PROJECT_NAME"
  --env-file "$ENV_FILE"
  -f "$COMPOSE_FILE"
  -f "$COMPOSE_BUILD_FILE"
)

echo "Building and starting the local Docker Panel stack..."
echo "  environment: $ENV_FILE"
echo "  project: $PROJECT_NAME"
echo "  source: local web and worker builds"
echo "  worker image: $LOCAL_WORKER_IMAGE"

"${compose[@]}" up -d --build --pull never "$@"

echo
"${compose[@]}" ps
