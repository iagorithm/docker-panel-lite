# Python Worker — Implementation Inventory

Runtime: Python  
Source: `services/worker/worker`  
Shared contract: [`WORKER_DESIGN.md`](WORKER_DESIGN.md)  
Last audit: 2026-07-21

This file contains only the Python implementation inventory. Protocol,
responsibilities, limits, and diagrams live in the shared contract.

Status legend: **Implemented**, **Partial**, **Pending**.

## Action Inventory

| Action | Implementation | Status | Remaining work |
| --- | --- | --- | --- |
| `discover_branches` | `executor.py:execute` → `core/git.py:list_remote_branches` | Implemented | — |
| `sync` | `executor.py:execute/_sync` → `core/git.py:sync_repo` | Implemented | — |
| `read_compose` | `executor.py:execute/_repository_file` | Implemented | — |
| `deploy` | `executor.py:execute/_run_compose/_run_dockerfile` | Implemented | Active cancellation remains cross-cutting. |
| `build` | `executor.py:execute/_run_compose/_run_dockerfile` | Implemented | Active cancellation remains cross-cutting. |
| `stop` | `executor.py:execute/_run_compose/_stop_public_tunnel` | Implemented | Active cancellation remains cross-cutting. |
| `tunnel_start` | `executor.py:execute/_start_public_tunnel` | Implemented | Active cancellation remains cross-cutting. |
| `tunnel_stop` | `executor.py:execute/_stop_public_tunnel` | Implemented | — |
| `inventory_refresh` | `main.py:Worker._process/_publish_container_inventory` | Implemented | — |
| `container_start` | `executor.py:execute_container` | Implemented | — |
| `container_stop` | `executor.py:execute_container` | Implemented | — |
| `container_restart` | `executor.py:execute_container` | Implemented | — |
| `container_delete` | `executor.py:execute_container` | Implemented | — |
| `container_logs` | `executor.py:execute_container` | Implemented | — |
| `container_exec` | `executor.py:execute_container_command` | Implemented | Does not interrupt an already-running exec after cancellation. |
| `worker_command` | `executor.py:execute_worker_command` | Implemented | Does not interrupt an already-running command after cancellation. |

## Auxiliary Function Inventory

| Capability | Python implementation | Status | Remaining work |
| --- | --- | --- | --- |
| Configuration and fallback file | `config.py:Settings.from_environment/_load_environment_file` | Implemented | — |
| Firebase URL/service account discovery | `config.py:_service_account_json/_project_id/_firebase_database_url` | Implemented | — |
| Stable worker ID | `config.py:_worker_id/_docker_host_fingerprint` | Implemented | — |
| Claim token and SHA-256 hash | `main.py:Worker._resolve_worker_token/__init__` | Implemented | — |
| Unique/preserved worker label | `main.py:Worker._resolve_worker_label` | Implemented | — |
| Firebase initialization/reference | `firebase_runtime.py:initialize/reference` | Implemented | — |
| Lifecycle and signal handling | `main.py:main/Worker.start/request_stop/stop` | Implemented | — |
| `online`/`stopping`/`offline` heartbeat | `main.py:Worker._heartbeat/_mark_stopping` | Implemented | — |
| Ownership/sharing preservation | `main.py:Worker._worker_payload` | Implemented | A failed pre-read can still fall back to empty ownership fields. |
| Docker summary and 60-second cache | `main.py:Worker._docker_summary` | Implemented | — |
| Realtime queue listeners | `main.py:Worker.start` | Implemented | — |
| Polling fallback and queue scan | `main.py:Worker.start/scan` | Implemented | — |
| Concurrency enforcement | `main.py:Worker.active/pool/scan` | Implemented | — |
| Transactional job lease | `main.py:Worker._claim` | Implemented | — |
| Lease renewal | `main.py:Worker._process:renew` | Implemented | Stops renewal on cancellation but does not interrupt every process. |
| Repository/container locks | `main.py:Worker._acquire_repository_lock/_release_repository_lock` | Implemented | — |
| Active cancellation | `main.py:Worker._claim/_process` | Partial | Observes before execution/finalization; no active process-tree interruption. |
| Mirrored job/deployment publication | `main.py:Worker._publish` | Implemented | — |
| Queue cleanup and post-job recovery | `main.py:Worker._process:finally` | Implemented | — |
| Container inventory and reconciliation | `main.py:Worker._publish_container_inventory`; `executor.py:container_inventory` | Implemented | — |
| Worker-container detection/protection | `main.py:Worker._is_worker_container`; `executor.py:_is_worker_container_object` | Implemented | — |
| Safe repository/file paths | `executor.py:_repo_path/_repository_file`; `core/utils.py:validate_relative_file_path` | Implemented | — |
| Git credential decrypt/injection/redaction | `executor.py:_credential`; `core/git.py` | Implemented | — |
| Git clone/pull/branches | `core/git.py` | Implemented | — |
| Environment parsing and precedence | `executor.py:_normalize_environment/_load_environment` | Implemented | — |
| `.env` and Compose override | `core/docker_ops.py:write_env_file`; `executor.py:_compose_override` | Implemented | — |
| Compose deploy/stop | `executor.py:_run_compose` | Implemented | No active cancellation after process start. |
| Dockerfile build/run/remove | `executor.py:_run_dockerfile` | Implemented | No active cancellation after build starts. |
| Deployment port collision validation | `executor.py:_configured_port_bindings/_compose_port_bindings/_validate_deployment_ports` | Implemented | Docker remains the final authority for races after validation. |
| Worker command parsing/timeout/output | `executor.py:_non_interactive_command/execute_worker_command` | Implemented | Active cancellation pending. |
| Container command parsing/timeout/output | `executor.py:_container_exec_shell_command/execute_container_command` | Implemented | Active cancellation pending. |
| AES-256-GCM secret decryption | `secrets.py:decrypt_secret` | Implemented | — |
| Tunnel target and Docker network attachment | `executor.py:_container_tunnel_target/_connect_worker_to_container_networks` | Implemented | — |
| Ngrok process/state lifecycle | `core/ngrok.py:NgrokService` | Implemented | Stale tunnel reconciliation can be improved. |
| Error compaction/output limits | `executor.py:_compact_process_error/_command_output`; `main.py:Worker._process` | Implemented | Stronger generic secret redaction is desirable. |
| Firebase application error registry | `main.py:Worker._record_app_error` and job/infrastructure exception boundaries | Implemented | Reporting is best-effort to avoid recursive Firebase failures. |
| Automated contract tests | No shared runtime fixture suite | Pending | Add the same action/protocol fixtures used by Go and future workers. |

## Summary

| Status | Count |
| --- | ---: |
| Actions implemented | 16/16 |
| Actions missing | 0/16 |
| Main functional gap | Active cancellation after process execution starts |
