#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

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
IMAGE="${IMAGE:-iagorithm/docker-panel-lite-worker}"
TAG="$(env_value WORKER_IMAGE_TAG)"
TAG="${TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
PLATFORMS="$(env_value WORKER_IMAGE_PLATFORMS)"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="$(env_value PUSH)"
PUSH="${PUSH:-true}"
PROGRESS="$(env_value BUILDKIT_PROGRESS)"
PROGRESS="${PROGRESS:-plain}"

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
  current_driver="$(docker buildx inspect 2>/dev/null | awk -F': +' '/^Driver:/ {print $2; exit}')"
  if [[ "$current_driver" != "docker" ]]; then
    return
  fi
  if docker buildx inspect "$builder" >/dev/null 2>&1; then
    docker buildx use "$builder" >/dev/null
  else
    docker buildx create --name "$builder" --driver docker-container --use >/dev/null
  fi
  docker buildx inspect --bootstrap >/dev/null
}

OUTPUT_FLAG=(--push)
if [[ "$PUSH" == "false" || "$PUSH" == "0" ]]; then
  OUTPUT_FLAG=(--load)
  PLATFORMS="${WORKER_IMAGE_PLATFORMS:-$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')}"
fi

ensure_builder

echo "Building worker image:"
echo "  image: $BASE_IMAGE"
echo "  tag: $TAG"
echo "  platforms: $PLATFORMS"
echo "  push: $PUSH"
echo "  builder: $(docker buildx inspect 2>/dev/null | awk -F': +' '/^Name:/ {print $2; exit}')"

docker buildx build \
  --progress "$PROGRESS" \
  --platform "$PLATFORMS" \
  -f "$ROOT_DIR/services/worker/Dockerfile" \
  -t "$BASE_IMAGE:$TAG" \
  -t "$BASE_IMAGE:latest" \
  "${OUTPUT_FLAG[@]}" \
  "$ROOT_DIR"

if [[ "$PUSH" != "false" && "$PUSH" != "0" ]]; then
  echo
  echo "Verifying pushed image:"
  docker buildx imagetools inspect "$BASE_IMAGE:$TAG"
  echo
  echo "Pushed:"
  echo "  $BASE_IMAGE:$TAG"
  echo "  $BASE_IMAGE:latest"
fi
