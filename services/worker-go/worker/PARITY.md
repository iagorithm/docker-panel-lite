# Python ↔ Go Worker Parity

The Go worker mirrors the Python worker by responsibility and filename wherever
the Go package model permits it. Shared behavior should be added to the matching
pair below, and parity changes should review both files together.

| Responsibility | Python | Go |
| --- | --- | --- |
| Process startup | `services/worker/worker/main.py` | `services/worker-go/worker/main.go` |
| Configuration and identity inputs | `services/worker/worker/config.py` | `services/worker-go/worker/config.go` |
| Job execution | `services/worker/worker/executor.py` | `services/worker-go/worker/executor.go` |
| Firebase runtime | `services/worker/worker/firebase_runtime.py` | `services/worker-go/worker/firebase_runtime.go` |
| Secret decryption | `services/worker/worker/secrets.py` | `services/worker-go/worker/secrets.go` |
| Docker operations | `services/worker/worker/core/docker_ops.py` | `services/worker-go/worker/core/docker_ops.go` |
| Git operations | `services/worker/worker/core/git.py` | `services/worker-go/worker/core/git.go` |
| Ngrok operations | `services/worker/worker/core/ngrok.py` | `services/worker-go/worker/core/ngrok.go` |
| Shared utilities | `services/worker/worker/core/utils.py` | `services/worker-go/worker/core/utils.go` |

## Go-only infrastructure

These packages make concurrency and lifecycle ownership explicit in Go. Their
behavior lives in `main.py` in the Python worker, so they do not have separate
Python files.

| Go package/file | Python comparison surface |
| --- | --- |
| `queue.go` and `realtime_todo.go` | `main.py` (`Worker` queue, lease, lock, listeners, cancellation and inventory methods) |
| `heartbeat.go` and `version.go` | `main.py` (`Worker` heartbeat and runtime metadata) |
| `identity.go` | `config.py` and `main.py` (persistent token and hash) |
| `core/command.go` | `executor.py` command parsing and Compose override helpers |
| `core/docker_sdk_todo.go` | Future replacement for `core/docker_ops.py` Docker SDK calls |

## Parity rule

1. A shared feature must be placed in the matching module from the first table.
2. A Go-only production file is allowed only for language-specific concurrency,
   lifecycle, build metadata, or a clearly marked future backend.
3. Public Go functions should use the Python function name translated to Go
   casing when they implement the same contract.
4. Every migration review must update the capability matrix in
   `docs/GO_WORKER.md` when parity changes.
5. Tests should use the same fixtures and expected protocol shapes for both
   runtimes once cross-runtime fixtures are introduced.
6. Cross-package and behavior tests belong in `worker/tests/`, never in a
   production package such as `core`. Package-private unit tests may remain next
   to their package only when they must verify non-exported implementation
   details.
