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

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "Worker parity structure is valid (${#pairs[@]} Python/Go pairs)."
