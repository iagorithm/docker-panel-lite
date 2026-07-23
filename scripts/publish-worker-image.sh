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

base_image_ref() {
  local image
  image="$(env_value WORKER_IMAGE)"
  image="${image:-cjarn/docker-panel-lite-worker:py}"
  if [[ "$image" == *:* ]]; then
    printf '%s' "${image%:*}"
  else
    printf '%s' "$image"
  fi
}

single_platform() {
  docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
}

ensure_builder() {
  local push="$1"
  local platforms="$2"
  local builder
  builder="$(env_value WORKER_BUILDX_BUILDER)"
  builder="${builder:-docker-panel-lite-builder}"
  if [[ "$push" == "false" || "$push" == "0" || "$platforms" != *,* ]]; then
    return
  fi

  local current_driver
  current_driver="$(docker buildx inspect 2>/dev/null | awk -F': +' '/^Driver:/ {print $2; exit}' || true)"
  if [[ "$current_driver" == "docker-container" ]]; then
    return
  fi

  echo "Preparing multi-platform builder: $builder"
  if docker buildx inspect "$builder" >/dev/null 2>&1; then
    docker buildx use "$builder"
  else
    docker buildx create --name "$builder" --driver docker-container --use
  fi
  docker buildx inspect --bootstrap >/dev/null
}

worker_config_secret() {
  local bake_config="$1"
  if [[ "$bake_config" != "true" && "$bake_config" != "1" && "$bake_config" != "yes" ]]; then
    return
  fi

  local config_text=""
  local config_keys=(
    FIREBASE_DATABASE_URL
    NEXT_PUBLIC_FIREBASE_DATABASE_URL
    FIREBASE_PROJECT_ID
    NEXT_PUBLIC_FIREBASE_PROJECT_ID
    FIREBASE_SERVICE_ACCOUNT_JSON
    CREDENTIAL_ENCRYPTION_KEY
    DEFAULT_WORKSPACE_ID
    WORKER_WORKSPACE_ID
    WORKER_POOL
    WORKER_GO_POOL
    WORKER_ID
    WORKER_GO_ID
    WORKER_TOKEN
    WORKER_GO_TOKEN
    WORKER_MACHINE_ID
    WORKER_GO_MACHINE_ID
    WORKER_LABEL
    WORKER_GO_LABEL
    WORKER_LOCATION
    WORKER_GO_LOCATION
    WORKER_SHARDS
    WORKER_GO_SHARDS
    WORKER_MAX_CONCURRENCY
    WORKER_GO_MAX_CONCURRENCY
    WORKER_LEASE_SECONDS
    WORKER_GO_LEASE_SECONDS
    WORKER_POLL_SECONDS
    WORKER_GO_POLL_SECONDS
    QUEUE_SHARDS
    NGROK_ENABLED
    NGROK_GO_ENABLED
    NGROK_AUTHTOKEN
    NGROK_GO_AUTHTOKEN
    NGROK_BIN
    NGROK_GO_BIN
    NGROK_REGION
    NGROK_GO_REGION
  )
  for key in "${config_keys[@]}"; do
    local value
    value="$(env_value "$key")"
    if [[ -n "$value" ]]; then
      config_text+="${key}=${value}"$'\n'
    fi
  done

  if [[ -z "$config_text" ]]; then
    echo "WORKER_BAKE_CONFIG is enabled, but no worker configuration values were found in $ENV_FILE." >&2
    exit 1
  fi

  local database_url firebase_project service_account encryption_key
  database_url="$(env_value FIREBASE_DATABASE_URL)"
  database_url="${database_url:-$(env_value NEXT_PUBLIC_FIREBASE_DATABASE_URL)}"
  firebase_project="$(env_value FIREBASE_PROJECT_ID)"
  firebase_project="${firebase_project:-$(env_value NEXT_PUBLIC_FIREBASE_PROJECT_ID)}"
  service_account="$(env_value FIREBASE_SERVICE_ACCOUNT_JSON)"
  encryption_key="$(env_value CREDENTIAL_ENCRYPTION_KEY)"
  if [[ -z "$database_url" && -z "$firebase_project" && -z "$service_account" ]]; then
    echo "Cannot bake worker fallback configuration: Firebase database URL or project identity is missing in $ENV_FILE." >&2
    exit 1
  fi
  if [[ -z "$service_account" || "$service_account" == "{}" ]]; then
    echo "Cannot bake worker fallback configuration: FIREBASE_SERVICE_ACCOUNT_JSON is missing in $ENV_FILE." >&2
    exit 1
  fi
  if [[ -z "$encryption_key" ]]; then
    echo "Cannot bake worker fallback configuration: CREDENTIAL_ENCRYPTION_KEY is missing in $ENV_FILE." >&2
    exit 1
  fi

  local secret_file
  secret_file="$(mktemp)"
  printf '%s' "$config_text" > "$secret_file"
  printf '%s' "$secret_file"
}

dockerfile_for_runtime() {
  case "$1" in
    py|python) printf '%s' "$ROOT_DIR/services/worker/Dockerfile" ;;
    go) printf '%s' "$ROOT_DIR/services/worker-go/Dockerfile" ;;
    *) echo "Unknown worker runtime: $1" >&2; exit 1 ;;
  esac
}

tag_for_runtime() {
  case "$1" in
    py|python) printf 'py' ;;
    go) printf 'go' ;;
    *) echo "Unknown worker runtime: $1" >&2; exit 1 ;;
  esac
}

build_runtime() {
  local runtime="$1"
  local base_image="$2"
  local platforms="$3"
  local push="$4"
  local progress="$5"
  local bake_config="$6"
  local worker_version="$7"
  local worker_commit="$8"
  local worker_build_date="$9"
  local dockerfile
  local tag
  dockerfile="$(dockerfile_for_runtime "$runtime")"
  tag="$(tag_for_runtime "$runtime")"

  local output_flag=(--push)
  if [[ "$push" == "false" || "$push" == "0" ]]; then
    output_flag=(--load)
  fi

  local build_secrets=()
  local secret_file=""
  secret_file="$(worker_config_secret "$bake_config")"
  if [[ -n "$secret_file" ]]; then
    build_secrets+=(--secret "id=worker_config,src=$secret_file")
  fi

  echo
  echo "Building worker image:"
  echo "  runtime: $tag"
  echo "  image: $base_image:$tag"
  echo "  platforms: $platforms"
  echo "  push: $push"
  if [[ "$tag" == "go" ]]; then
    echo "  configuration: compiled from services/worker-go/worker/environment.go"
  else
    echo "  baked config: $([[ "$bake_config" == "true" || "$bake_config" == "1" || "$bake_config" == "yes" ]] && echo yes || echo no)"
  fi
  if [[ "$tag" == "go" ]]; then
    echo "  worker version: $worker_version"
    echo "  worker commit: $worker_commit"
    echo "  worker build date: $worker_build_date"
  fi
  if [[ "$bake_config" == "true" || "$bake_config" == "1" || "$bake_config" == "yes" ]]; then
    echo "  warning: baked config is intended for private images only"
  fi

  local build_command=(
    docker buildx build
    --progress "$progress"
    --platform "$platforms"
    -f "$dockerfile"
    -t "$base_image:$tag"
  )
  if [[ "$bake_config" == "true" || "$bake_config" == "1" || "$bake_config" == "yes" ]]; then
    build_command+=(--build-arg WORKER_CONFIG_REQUIRED=true)
  fi
  if [[ "$tag" == "go" ]]; then
    build_command+=(
      --build-arg "WORKER_VERSION=$worker_version"
      --build-arg "WORKER_COMMIT=$worker_commit"
      --build-arg "WORKER_BUILD_DATE=$worker_build_date"
    )
  fi
  if [[ "${#build_secrets[@]}" -gt 0 ]]; then
    build_command+=("${build_secrets[@]}")
  fi
  build_command+=("${output_flag[@]}" "$ROOT_DIR")

  if ! "${build_command[@]}"; then
    if [[ -n "$secret_file" ]]; then
      rm -f "$secret_file"
    fi
    echo
    echo "Worker image build/publish failed for runtime '$tag'."
    if [[ "$push" != "false" && "$push" != "0" ]]; then
      echo
      echo "If the error says 'push access denied' or 'insufficient_scope', Docker Hub rejected the push."
      echo "Check one of these:"
      echo "  1. Run: docker login"
      echo "  2. Make sure WORKER_IMAGE uses a namespace you can push to: $base_image"
      echo "  3. Create the Docker Hub repository before pushing, especially for private/org repositories."
      echo "  4. If this is an org repo, confirm your Docker Hub user has Write permission."
      echo
      echo "Example:"
      echo "  WORKER_IMAGE=<your-dockerhub-user>/docker-panel-lite-worker:py ./run.sh publish"
    fi
    exit 1
  fi

  if [[ -n "$secret_file" ]]; then
    rm -f "$secret_file"
  fi
}

main() {
  local target="${1:-all}"
  case "$target" in
    all|both) ;;
    py|python|go) ;;
    *) echo "Usage: ./run.sh publish [all|py|go]" >&2; exit 1 ;;
  esac

  if ! docker buildx version >/dev/null 2>&1; then
    echo "Docker buildx is required." >&2
    exit 1
  fi

  local base_image platforms push progress bake_config worker_version worker_commit worker_build_date
  base_image="$(base_image_ref)"
  platforms="$(env_value WORKER_IMAGE_PLATFORMS)"
  platforms="${platforms:-linux/amd64,linux/arm64}"
  push="$(env_value PUSH)"
  push="${push:-true}"
  progress="$(env_value BUILDKIT_PROGRESS)"
  progress="${progress:-plain}"
  bake_config="$(env_value WORKER_BAKE_CONFIG)"
  bake_config="${bake_config:-true}"
  worker_commit="$(git -C "$ROOT_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  worker_commit="${worker_commit:-unknown}"
  worker_version="$(env_value WORKER_VERSION)"
  worker_version="${worker_version:-$worker_commit}"
  worker_build_date="$(git -C "$ROOT_DIR" show -s --format=%cI HEAD 2>/dev/null || true)"
  worker_build_date="${worker_build_date:-unknown}"

  if [[ "$push" == "false" || "$push" == "0" ]]; then
    platforms="$(single_platform)"
  fi
  ensure_builder "$push" "$platforms"

  echo "Preparing worker image publication..."
  echo "  repository: $base_image"
  echo "  target: $target"

  case "$target" in
    all|both)
      build_runtime py "$base_image" "$platforms" "$push" "$progress" "$bake_config" "$worker_version" "$worker_commit" "$worker_build_date"
      build_runtime go "$base_image" "$platforms" "$push" "$progress" "$bake_config" "$worker_version" "$worker_commit" "$worker_build_date"
      ;;
    py|python)
      build_runtime py "$base_image" "$platforms" "$push" "$progress" "$bake_config" "$worker_version" "$worker_commit" "$worker_build_date"
      ;;
    go)
      build_runtime go "$base_image" "$platforms" "$push" "$progress" "$bake_config" "$worker_version" "$worker_commit" "$worker_build_date"
      ;;
  esac

  if [[ "$push" != "false" && "$push" != "0" ]]; then
    echo
    echo "Verifying pushed images:"
    case "$target" in
      all|both|py|python) docker buildx imagetools inspect "$base_image:py" ;;
    esac
    case "$target" in
      all|both|go) docker buildx imagetools inspect "$base_image:go" ;;
    esac
    echo
    echo "Pushed:"
    case "$target" in
      all|both|py|python) echo "  $base_image:py" ;;
    esac
    case "$target" in
      all|both|go) echo "  $base_image:go" ;;
    esac
  fi
}

main "$@"
