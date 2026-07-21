#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

publish_error() {
  local status="$1"
  local line="$2"
  echo "Worker image publication stopped unexpectedly near line $line (exit $status)." >&2
  echo "Run again after checking the Docker/Buildx message immediately above." >&2
}

trap 'status=$?; publish_error "$status" "$LINENO"; exit "$status"' ERR

echo "Preparing worker image publication..."

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

IMAGE="$(env_value WORKER_IMAGE)"
IMAGE="${IMAGE:-cjarn/docker-panel-lite-worker}"
TAG="$(env_value WORKER_IMAGE_TAG)"
TAG="${TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
PLATFORMS="$(env_value WORKER_IMAGE_PLATFORMS)"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="$(env_value PUSH)"
PUSH="${PUSH:-true}"
PROGRESS="$(env_value BUILDKIT_PROGRESS)"
PROGRESS="${PROGRESS:-plain}"
BAKE_CONFIG="$(env_value WORKER_BAKE_CONFIG)"
BAKE_CONFIG="${BAKE_CONFIG:-true}"

if [[ "$IMAGE" == *:* ]]; then
  BASE_IMAGE="${IMAGE%:*}"
  DEFAULT_TAG="${IMAGE##*:}"
else
  BASE_IMAGE="$IMAGE"
  DEFAULT_TAG="latest"
fi

if [[ "$TAG" == "latest" && "$DEFAULT_TAG" != "latest" ]]; then
  TAG="$DEFAULT_TAG"
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "Docker buildx is required."
  exit 1
fi

ensure_builder() {
  local builder
  builder="$(env_value WORKER_BUILDX_BUILDER)"
  builder="${builder:-docker-panel-lite-builder}"
  if [[ "$PUSH" == "false" || "$PUSH" == "0" || "$PLATFORMS" != *,* ]]; then
    return
  fi
  local current_driver
  current_driver="$(docker buildx inspect 2>/dev/null | awk -F': +' '/^Driver:/ {print $2; exit}' || true)"
  if [[ "$current_driver" == "docker-container" ]]; then
    return
  fi

  echo "Preparing multi-platform builder: $builder"
  if docker buildx inspect "$builder" >/dev/null 2>&1; then
    if ! docker buildx use "$builder"; then
      echo "Could not select Docker Buildx builder '$builder'." >&2
      return 1
    fi
  else
    if ! docker buildx create --name "$builder" --driver docker-container --use; then
      echo "Could not create Docker Buildx builder '$builder'." >&2
      return 1
    fi
  fi
  if ! docker buildx inspect --bootstrap; then
    echo "Could not start Docker Buildx builder '$builder'." >&2
    return 1
  fi
}

OUTPUT_FLAG=(--push)
if [[ "$PUSH" == "false" || "$PUSH" == "0" ]]; then
  OUTPUT_FLAG=(--load)
  PLATFORMS="${WORKER_IMAGE_PLATFORMS:-$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')}"
fi

ensure_builder

BUILD_SECRETS=()
if [[ "$BAKE_CONFIG" == "true" || "$BAKE_CONFIG" == "1" || "$BAKE_CONFIG" == "yes" ]]; then
  CONFIG_TEXT=""
  CONFIG_KEYS=(
    FIREBASE_DATABASE_URL
    NEXT_PUBLIC_FIREBASE_DATABASE_URL
    FIREBASE_PROJECT_ID
    NEXT_PUBLIC_FIREBASE_PROJECT_ID
    FIREBASE_SERVICE_ACCOUNT_JSON
    CREDENTIAL_ENCRYPTION_KEY
    WORKER_WORKSPACE_ID
    WORKER_POOL
    WORKER_SHARDS
    WORKER_MAX_CONCURRENCY
    WORKER_LEASE_SECONDS
    WORKER_POLL_SECONDS
    QUEUE_SHARDS
    NGROK_ENABLED
    NGROK_AUTHTOKEN
    NGROK_REGION
  )
  for key in "${CONFIG_KEYS[@]}"; do
    value="$(env_value "$key")"
    if [[ -n "$value" ]]; then
      CONFIG_TEXT+="${key}=${value}"$'\n'
    fi
  done
  if [[ -z "$CONFIG_TEXT" ]]; then
    echo "WORKER_BAKE_CONFIG is enabled, but no worker configuration values were found in $ENV_FILE."
    exit 1
  fi
  DATABASE_URL="$(env_value FIREBASE_DATABASE_URL)"
  DATABASE_URL="${DATABASE_URL:-$(env_value NEXT_PUBLIC_FIREBASE_DATABASE_URL)}"
  FIREBASE_PROJECT="$(env_value FIREBASE_PROJECT_ID)"
  FIREBASE_PROJECT="${FIREBASE_PROJECT:-$(env_value NEXT_PUBLIC_FIREBASE_PROJECT_ID)}"
  SERVICE_ACCOUNT="$(env_value FIREBASE_SERVICE_ACCOUNT_JSON)"
  ENCRYPTION_KEY="$(env_value CREDENTIAL_ENCRYPTION_KEY)"
  if [[ -z "$DATABASE_URL" && -z "$FIREBASE_PROJECT" && -z "$SERVICE_ACCOUNT" ]]; then
    echo "Cannot bake worker fallback configuration: Firebase database URL or project identity is missing in $ENV_FILE." >&2
    exit 1
  fi
  if [[ -z "$SERVICE_ACCOUNT" || "$SERVICE_ACCOUNT" == "{}" ]]; then
    echo "Cannot bake worker fallback configuration: FIREBASE_SERVICE_ACCOUNT_JSON is missing in $ENV_FILE." >&2
    exit 1
  fi
  if [[ -z "$ENCRYPTION_KEY" ]]; then
    echo "Cannot bake worker fallback configuration: CREDENTIAL_ENCRYPTION_KEY is missing in $ENV_FILE." >&2
    exit 1
  fi
  WORKER_CONFIG_SECRET="$(mktemp)"
  trap 'rm -f "$WORKER_CONFIG_SECRET"' EXIT
  printf '%s' "$CONFIG_TEXT" > "$WORKER_CONFIG_SECRET"
  BUILD_SECRETS+=(--secret "id=worker_config,src=$WORKER_CONFIG_SECRET")
fi

echo "Building worker image:"
echo "  image: $BASE_IMAGE"
echo "  tag: $TAG"
echo "  platforms: $PLATFORMS"
echo "  push: $PUSH"
echo "  builder: $(docker buildx inspect 2>/dev/null | awk -F': +' '/^Name:/ {print $2; exit}')"
echo "  baked config: $([[ "$BAKE_CONFIG" == "true" || "$BAKE_CONFIG" == "1" || "$BAKE_CONFIG" == "yes" ]] && echo yes || echo no)"
if [[ "$BAKE_CONFIG" == "true" || "$BAKE_CONFIG" == "1" || "$BAKE_CONFIG" == "yes" ]]; then
  echo "  warning: baked config is intended for private images only"
fi

BUILD_COMMAND=(
  docker buildx build
  --progress "$PROGRESS"
  --platform "$PLATFORMS"
  -f "$ROOT_DIR/services/worker/Dockerfile"
  -t "$BASE_IMAGE:$TAG"
  -t "$BASE_IMAGE:latest"
)
if [[ "$BAKE_CONFIG" == "true" || "$BAKE_CONFIG" == "1" || "$BAKE_CONFIG" == "yes" ]]; then
  BUILD_COMMAND+=(--build-arg WORKER_CONFIG_REQUIRED=true)
fi
if [[ "${#BUILD_SECRETS[@]}" -gt 0 ]]; then
  BUILD_COMMAND+=("${BUILD_SECRETS[@]}")
fi
BUILD_COMMAND+=("${OUTPUT_FLAG[@]}" "$ROOT_DIR")

if ! "${BUILD_COMMAND[@]}"; then
  echo
  echo "Worker image build/publish failed."
  if [[ "$PUSH" != "false" && "$PUSH" != "0" ]]; then
    echo
    echo "If the error says 'push access denied' or 'insufficient_scope', Docker Hub rejected the push."
    echo "Check one of these:"
    echo "  1. Run: docker login"
    echo "  2. Make sure WORKER_IMAGE uses a namespace you can push to: $BASE_IMAGE"
    echo "  3. Create the Docker Hub repository before pushing, especially for private/org repositories."
    echo "  4. If this is an org repo, confirm your Docker Hub user has Write permission."
    echo
    echo "Example:"
    echo "  WORKER_IMAGE=<your-dockerhub-user>/docker-panel-lite-worker:latest ./run.sh publish-worker"
  fi
  exit 1
fi

if [[ "$PUSH" != "false" && "$PUSH" != "0" ]]; then
  echo
  echo "Verifying pushed image:"
  docker buildx imagetools inspect "$BASE_IMAGE:$TAG"
  echo
  echo "Pushed:"
  echo "  $BASE_IMAGE:$TAG"
  echo "  $BASE_IMAGE:latest"
fi
