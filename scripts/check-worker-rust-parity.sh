#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$ROOT_DIR/services/worker-rust/src"
required_files=(environment.rs firebase.rs heartbeat.rs identity.rs operations.rs queue.rs main.rs)

for file in "${required_files[@]}"; do
  if [[ ! -f "$RUST_DIR/$file" ]]; then
    echo "Missing Rust worker runtime module: $file" >&2
    exit 1
  fi
done

actions=(
  inventory_refresh
  worker_command
  container_exec
  container_start
  container_stop
  container_restart
  container_delete
  container_logs
  container_tunnel_start
  discover_branches
  sync
  read_compose
  read_dockerfile
  deploy
  build
  stop
  tunnel_start
  tunnel_stop
)

implemented=0
for action in "${actions[@]}"; do
  if grep -RqsF "\"$action\"" "$RUST_DIR"; then
    printf '[x] %s\n' "$action"
    implemented=$((implemented + 1))
  else
    printf '[ ] %s\n' "$action"
  fi
done

if grep -RqE 'std::env::var|std::env::vars|env::var\(' "$RUST_DIR"; then
  echo "Rust runtime must not read process environment variables." >&2
  exit 1
fi

for marker in 'put_if_match' 'leaseExpiresAt' 'workerTokenHash' 'protectedActions' 'publicTunnelStatus'; do
  if ! grep -RqsF "$marker" "$RUST_DIR"; then
    echo "Rust worker is missing parity behavior marker: $marker" >&2
    exit 1
  fi
done

if [[ "$implemented" -ne "${#actions[@]}" ]]; then
  exit 1
fi

printf 'Rust worker contract: %d/%d actions and %d runtime modules present.\n' "$implemented" "${#actions[@]}" "${#required_files[@]}"
