#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pairs=(
  "services/worker/worker/main.py|services/worker-go/worker/main.go"
  "services/worker/worker/config.py|services/worker-go/worker/config.go"
  "services/worker/worker/executor.py|services/worker-go/worker/executor.go"
  "services/worker/worker/firebase_runtime.py|services/worker-go/worker/firebase_runtime.go"
  "services/worker/worker/secrets.py|services/worker-go/worker/secrets.go"
  "services/worker/worker/core/docker_ops.py|services/worker-go/worker/core/docker_ops.go"
  "services/worker/worker/core/git.py|services/worker-go/worker/core/git.go"
  "services/worker/worker/core/ngrok.py|services/worker-go/worker/core/ngrok.go"
  "services/worker/worker/core/utils.py|services/worker-go/worker/core/utils.go"
)

failed=0
for pair in "${pairs[@]}"; do
  python_file="${pair%%|*}"
  go_file="${pair#*|}"
  if [[ ! -f "$ROOT_DIR/$python_file" ]]; then
    echo "Missing Python parity file: $python_file" >&2
    failed=1
  fi
  if [[ ! -f "$ROOT_DIR/$go_file" ]]; then
    echo "Missing Go parity file: $go_file" >&2
    failed=1
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

python_sources=(
  "$ROOT_DIR/services/worker/worker/main.py"
  "$ROOT_DIR/services/worker/worker/executor.py"
)
go_sources=(
  "$ROOT_DIR/services/worker-go/worker/queue.go"
  "$ROOT_DIR/services/worker-go/worker/executor.go"
)

for action in "${actions[@]}"; do
  if ! grep -Fq "\"$action\"" "${python_sources[@]}"; then
    echo "Python worker is missing required action: $action" >&2
    failed=1
  fi
  if ! grep -Fq "\"$action\"" "${go_sources[@]}"; then
    echo "Go worker is missing required action: $action" >&2
    failed=1
  fi
done

for marker in publicTunnelError app_logs "deployment port collision"; do
  if ! grep -RiqF "$marker" "$ROOT_DIR/services/worker/worker"; then
    echo "Python worker is missing parity behavior marker: $marker" >&2
    failed=1
  fi
  if ! grep -RiqF "$marker" "$ROOT_DIR/services/worker-go/worker"; then
    echo "Go worker is missing parity behavior marker: $marker" >&2
    failed=1
  fi
done

if grep -RqE 'os\.(Getenv|LookupEnv)' "$ROOT_DIR/services/worker-go/worker"; then
  echo "Go worker must use compiled environment.go configuration, not runtime environment variables." >&2
  failed=1
fi

if [[ ! -f "$ROOT_DIR/services/worker-go/worker/environment.go" ]]; then
  echo "Missing compiled Go worker configuration: services/worker-go/worker/environment.go" >&2
  failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Worker parity contract is valid (${#pairs[@]} file pairs, ${#actions[@]} shared actions)."
