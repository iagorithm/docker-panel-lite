# Go Worker — Implementation Inventory

Runtime: Go  
Source: `services/worker-go/worker`  
Shared contract: [`WORKER_DESIGN.md`](WORKER_DESIGN.md)  
Python reference inventory: [`WORKER_DESIGN_PY.md`](WORKER_DESIGN_PY.md)  
Last audit: 2026-07-21

This file contains only the Go implementation inventory. Protocol,
responsibilities, limits, and diagrams live in the shared contract.

Status legend: **Implemented**, **Partial**, **Pending**.

## Action Inventory

| Action | Go implementation | Status | Remaining work |
| --- | --- | --- | --- |
| `discover_branches` | `executor.go:Execute` → `core/git.go:ListRemoteBranches` | Implemented | Add shared contract fixtures. |
| `sync` | `executor.go:Execute/syncRepository` → `core/git.go:SyncRepo` | Implemented | Add shared contract fixtures. |
| `read_compose` | `executor.go:Execute/repositoryFile` | Implemented | Add shared contract fixtures. |
| `deploy` | `executor.go:Execute` → `core.RunCompose/RunDockerfile` | Partial | Propagate cancellation; validate environment/Compose parity and live deployments. |
| `build` | `executor.go:Execute` → `core.RunCompose/RunDockerfile` | Partial | Propagate cancellation and validate Docker build behavior. |
| `stop` | `executor.go:Execute` → `core.RunCompose/StopDockerfileContainer` | Partial | Propagate cancellation and add integration coverage. |
| `tunnel_start` | `executor.go:startPublicTunnel` → `core.PublicTunnelTargets/NgrokService` | Partial | Docker network attachment is implemented; active cancellation and integration coverage remain. |
| `tunnel_stop` | `executor.go:stopPublicTunnel` → `core.NgrokService.StopPrefix` | Implemented | Add integration coverage. |
| `inventory_refresh` | `queue.go:Runner.execute/PublishContainerInventory` | Implemented | Add Python/Go record fixtures. |
| `container_start` | `queue.go:Runner.execute` → `core.ContainerAction` | Implemented | Add Docker integration coverage. |
| `container_stop` | `queue.go:Runner.execute` → `core.ContainerAction` | Implemented | Strengthen worker detection parity. |
| `container_restart` | `queue.go:Runner.execute` → `core.ContainerAction` | Implemented | Add Docker integration coverage. |
| `container_delete` | `queue.go:Runner.execute` → `core.ContainerAction` | Implemented | Strengthen worker detection parity. |
| `container_logs` | `queue.go:Runner.execute` → `core.ContainerAction` | Implemented | Add truncation fixtures. |
| `container_exec` | `queue.go:Runner.execute` → `core.ContainerExecContext` | Partial | Remove `docker exec -i`; add Firebase-driven cancellation integration test. |
| `worker_command` | `executor.go:ExecuteWorkerCommand` → `core.RunWorkerCommandContext` | Partial | Match Python parsing fixtures and add Firebase-driven cancellation test. |

## Auxiliary Function Inventory

| Capability | Go implementation | Status | Remaining work |
| --- | --- | --- | --- |
| Configuration and fallback file | `config.go:FromEnvironment/loadEnvironmentFile` | Implemented | — |
| Firebase URL/service account discovery | `config.go:serviceAccountJSON/firebaseDatabaseURL` | Implemented | — |
| Stable worker ID | `config.go:workerID/dockerHostFingerprint` | Implemented | — |
| Claim token and SHA-256 hash | `identity.go:ResolveWorkerToken/SHA256Hex` | Implemented | — |
| Unique/preserved worker label | `main.go:resolveWorkerLabel` | Implemented | — |
| Firebase REST authentication/client | `firebase_runtime.go:NewFirebaseClient/Client` | Implemented | — |
| Firebase retry and token-safe errors | `firebase_runtime.go:Client.request` | Implemented | Restore dedicated regression tests in `worker/tests`. |
| Lifecycle and signal handling | `main.go:main`; `queue.go:Runner.StopAccepting/Wait` | Implemented | Publishes `stopping`, rejects new jobs, drains active jobs, then publishes `offline`. |
| Heartbeat publication | `heartbeat.go:Agent.Send` | Implemented | Separate heartbeat cadence from polling if required. |
| Ownership/sharing preservation | `heartbeat.go:Agent.Send` | Partial | Do not overwrite metadata when the pre-read fails. |
| Docker summary cache | `core/docker_ops.go:DockerSummaryNow` | Pending | Add bounded cache equivalent to Python's 60 seconds. |
| Realtime queue listeners | `realtime_todo.go:RunRealtime` | Pending | Implement authenticated Firebase SSE/listener with reconnect and polling fallback. |
| Polling queue scan | `queue.go:Runner.Run/scan` | Implemented | — |
| Concurrency enforcement | `queue.go:Runner.capacity/markActive` | Implemented | — |
| Conditional ETag job lease | `queue.go:Runner.claim`; `firebase_runtime.go` | Implemented | Add contention/recovery fixtures. |
| Lease renewal | `queue.go:Runner.renewLease` | Implemented | Non-cancellable operations can outlive lease renewal after cancellation. |
| Repository/container locks | `queue.go:Runner.acquireLock/releaseLock` | Implemented | Add contention and stale-lock fixtures. |
| Active cancellation watcher | `realtime_todo.go:WatchActiveCancellation` | Partial | Polls cancellation; remaining operations do not accept context. |
| Process-tree cancellation | `core/docker_ops.go:commandOutputWithExitContext` | Partial | Implemented for worker/container commands only. |
| Mirrored job/deployment publication | `queue.go:Runner.publish` | Implemented | Add protocol fixtures. |
| Queue cleanup and post-job recovery | `queue.go:Runner.process/clearActive` | Implemented | Integrated with graceful shutdown wait group. |
| Container inventory and reconciliation | `queue.go:Runner.PublishContainerInventory`; `core.ContainerInventory` | Implemented | Add record-shape parity fixtures. |
| Worker-container detection/protection | `core.IsWorkerContainerName/ContainerAction/ContainerExecContext` | Partial | Include hostname/container-ID detection equivalent to Python. |
| Safe repository/file paths | `executor.go:repoPath/repositoryFile`; `core.ValidateRelativeFilePath` | Implemented | Match Python rejection fixtures for `~`, backslash, NUL, and trailing directories. |
| Git credential decrypt/injection/redaction | `executor.go:credential`; `core/git.go` | Implemented | Add encoded-token redaction fixtures. |
| Git clone/pull/branches | `core/git.go` | Implemented | Propagate cancellation context and terminate process groups. |
| Environment parsing and precedence | `executor.go:normalizeEnvironment/loadEnvironment` | Partial | Add list `{key/name/value}`, multiline continuation, inline comments, and trailing-comma JSON parity. |
| `.env` writer | `core/docker_ops.go:WriteEnvFile` | Implemented | Add shared escaping fixtures. |
| Compose service override | `core/command.go:WriteComposeOverride` | Partial | Replace regex service discovery with real YAML parsing or shared fixtures. |
| Compose deploy/stop | `core/docker_ops.go:RunCompose` | Partial | Context cancellation and integration validation pending. |
| Dockerfile build/run/remove | `core/docker_ops.go:RunDockerfile/StopDockerfileContainer` | Partial | Context cancellation and integration validation pending. |
| Worker command parsing/timeout/output | `core/command.go`; `core.RunWorkerCommandContext` | Partial | Match `shlex` edge cases and add contract fixtures. |
| Container command parsing/timeout/output | `core/command.go`; `core.ContainerExecContext` | Partial | Remove stdin flag and add contract fixtures. |
| AES-256-GCM secret decryption | `secrets.go:DecryptSecret` | Implemented | Add shared Python/Go ciphertext fixtures. |
| Tunnel target discovery | `core/docker_ops.go:PublicTunnelTargets/connectWorkerToContainerNetworks` | Implemented | Prefers published host ports and attaches the worker before using internal IP. |
| Ngrok process/state lifecycle | `core/ngrok.go:NgrokService` | Partial | Propagate context and add restart/stale-state integration tests. |
| Error compaction/output limits | `core/docker_ops.go`; `queue.go:Runner.fail` | Implemented | Add generic secret-redaction policy. |
| Immutable build metadata | `version.go`; Docker `-ldflags` | Implemented | — |
| Docker SDK backend | `core/docker_sdk_todo.go` | Pending | Optional for internal parity; CLI can satisfy behavioral contract. |
| Automated contract tests | `worker/tests` | Pending | Only active command cancellation currently has coverage. |

## Summary

| Status | Count |
| --- | ---: |
| Actions implemented | 10/16 |
| Actions partial | 6/16 |
| Actions pending/missing | 0/16 |
| Highest-priority gaps | Full cancellation, realtime listener, tunnel network attachment, environment parity |
