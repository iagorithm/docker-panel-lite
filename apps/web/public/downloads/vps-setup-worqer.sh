#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_IMAGE_REPOSITORY="cjarn/docker-panel-lite-worker"
readonly DEFAULT_CONTAINER_NAME="worqer-worker"
readonly DEFAULT_DATA_DIR="/opt/worqer"

runtime="${WORQER_RUNTIME:-py}"
image_repository="${WORQER_IMAGE_REPOSITORY:-$DEFAULT_IMAGE_REPOSITORY}"
container_name="${WORQER_CONTAINER_NAME:-$DEFAULT_CONTAINER_NAME}"
data_dir="${WORQER_DATA_DIR:-$DEFAULT_DATA_DIR}"
replace_container=false

usage() {
  cat <<'EOF'
Install Docker Engine and start a worqer.app worker on Ubuntu or Debian.

Usage:
  sudo ./scripts/vps-setup-worqer.sh [options]

Options:
  --runtime py|go       Worker runtime tag (default: py)
  --name NAME           Docker container name (default: worqer-worker)
  --data-dir PATH       Persistent host directory (default: /opt/worqer)
  --image REPOSITORY    Worker image without a tag
  --replace             Replace the existing named worker container
  -h, --help            Show this help

Environment alternatives:
  WORQER_RUNTIME, WORQER_CONTAINER_NAME, WORQER_DATA_DIR,
  WORQER_IMAGE_REPOSITORY

Examples:
  sudo ./scripts/vps-setup-worqer.sh --runtime py
  sudo ./scripts/vps-setup-worqer.sh --runtime go
  sudo ./scripts/vps-setup-worqer.sh --runtime go --replace
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  printf '\nSetup failed on line %s (exit %s).\n' "${BASH_LINENO[0]}" "$exit_code" >&2
  exit "$exit_code"
}
trap on_error ERR

while (($#)); do
  case "$1" in
    --runtime)
      (($# >= 2)) || fail "--runtime requires py or go."
      runtime="$2"
      shift 2
      ;;
    --name)
      (($# >= 2)) || fail "--name requires a value."
      container_name="$2"
      shift 2
      ;;
    --data-dir)
      (($# >= 2)) || fail "--data-dir requires an absolute path."
      data_dir="$2"
      shift 2
      ;;
    --image)
      (($# >= 2)) || fail "--image requires a repository without a tag."
      image_repository="$2"
      shift 2
      ;;
    --replace)
      replace_container=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ "$runtime" == "py" || "$runtime" == "go" ]] || fail "Runtime must be py or go."
[[ "$data_dir" == /* ]] || fail "Data directory must be an absolute path."
[[ "$container_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || fail "Invalid container name."
[[ "$image_repository" != *":"* ]] || fail "Pass --image without a tag; --runtime selects :py or :go."

if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || fail "Run this script as root or install sudo."
  sudo_args=(
    --runtime "$runtime"
    --name "$container_name"
    --data-dir "$data_dir"
    --image "$image_repository"
  )
  if $replace_container; then
    sudo_args+=(--replace)
  fi
  exec sudo -- "$0" "${sudo_args[@]}"
fi

[[ -r /etc/os-release ]] || fail "Cannot identify this Linux distribution."
# shellcheck disable=SC1091
. /etc/os-release

case "${ID:-}" in
  ubuntu|debian) docker_distribution="$ID" ;;
  *) fail "Supported operating systems: Ubuntu and Debian. Detected: ${ID:-unknown}." ;;
esac

[[ -n "${VERSION_CODENAME:-}" ]] || fail "VERSION_CODENAME is missing from /etc/os-release."

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    printf 'Docker is already installed: %s\n' "$(docker --version)"
    return
  fi

  printf 'Installing Docker Engine from the official %s repository...\n' "$docker_distribution"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl

  # Remove packages that conflict with Docker Engine's official packages.
  apt-get remove -y docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc || true

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${docker_distribution}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${docker_distribution}
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker
systemctl enable --now docker
docker info >/dev/null

repos_dir="${data_dir}/repos"
state_dir="${data_dir}/data"
install -d -m 0750 "$data_dir" "$repos_dir" "$state_dir"

worker_image="${image_repository}:${runtime}"
printf 'Pulling %s...\n' "$worker_image"
if ! docker pull "$worker_image"; then
  fail "Unable to pull $worker_image. If the repository is private, run 'docker login' and retry."
fi

if docker container inspect "$container_name" >/dev/null 2>&1; then
  if $replace_container; then
    printf 'Replacing existing container %s...\n' "$container_name"
    docker rm -f "$container_name"
  else
    current_status="$(docker inspect --format '{{.State.Status}}' "$container_name")"
    printf 'Container %s already exists with status %s.\n' "$container_name" "$current_status"
    if [[ "$current_status" != "running" ]]; then
      docker start "$container_name" >/dev/null
      printf 'Existing worker started. Use --replace to recreate it with %s.\n' "$worker_image"
    else
      printf 'Existing worker left unchanged. Use --replace to recreate it with %s.\n' "$worker_image"
    fi
    docker logs --tail 100 "$container_name" || true
    exit 0
  fi
fi

printf 'Starting worqer.app worker...\n'
docker run -d \
  --name "$container_name" \
  --hostname "$(hostname)" \
  --restart unless-stopped \
  --label app.worqer.role=worker \
  --label app.worqer.runtime="$runtime" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${repos_dir}:/app/clones" \
  -v "${state_dir}:/app/data" \
  "$worker_image" >/dev/null

printf 'Waiting for the worker to initialize'
for _attempt in $(seq 1 20); do
  if docker logs "$container_name" 2>&1 | grep -qi "claim token"; then
    break
  fi
  printf '.'
  sleep 1
done
printf '\n\n'

docker ps --filter "name=^/${container_name}$" --format 'Worker: {{.Names}} | Status: {{.Status}} | Image: {{.Image}}'
printf '\nWorker logs (copy the claim token into worqer.app > Workers):\n\n'
docker logs --tail 100 "$container_name"

cat <<EOF

Setup complete.

Persistent data: ${data_dir}
Runtime:         ${runtime}
Image:           ${worker_image}

Useful commands:
  docker logs --tail 100 ${container_name}
  docker restart ${container_name}
  docker ps --filter name=${container_name}
EOF
