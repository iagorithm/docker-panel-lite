#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

IMAGE="${WORKER_IMAGE:-iagorithm/docker-panel-lite-worker}"
TAG="${WORKER_IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
PLATFORMS="${WORKER_IMAGE_PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-true}"

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

OUTPUT_FLAG=(--push)
if [[ "$PUSH" == "false" || "$PUSH" == "0" ]]; then
  OUTPUT_FLAG=(--load)
  PLATFORMS="${WORKER_IMAGE_PLATFORMS:-$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')}"
fi

echo "Building worker image:"
echo "  image: $BASE_IMAGE"
echo "  tag: $TAG"
echo "  platforms: $PLATFORMS"
echo "  push: $PUSH"

docker buildx build \
  --platform "$PLATFORMS" \
  -f "$ROOT_DIR/services/worker/Dockerfile" \
  -t "$BASE_IMAGE:$TAG" \
  -t "$BASE_IMAGE:latest" \
  "${OUTPUT_FLAG[@]}" \
  "$ROOT_DIR"
