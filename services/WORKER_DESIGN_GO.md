# Go Worker — Parity Audit

Runtime: Go  
Source: `services/worker-go/worker`  
Shared contract: [`WORKER_DESIGN.md`](WORKER_DESIGN.md)  
Python reference: [`WORKER_DESIGN_PY.md`](WORKER_DESIGN_PY.md)  
Last audit: 2026-07-22

The Go worker implements every dashboard operation supported by the Python
worker. Run `./scripts/check-worker-parity.sh` to verify the shared action and
failure-reporting contract.

## Intentional runtime difference

Python reads its worker configuration from runtime environment variables and an
optional fallback file. Go reads `worker/environment.go`; these values are
compiled into the executable and runtime environment variables are ignored.
Generated worker identity and claim-token files remain installation-specific.

## Action contract

| Area | Shared actions | Go status |
| --- | --- | --- |
| Queue | `inventory_refresh` | Implemented |
| Commands | `worker_command`, `container_exec` | Implemented |
| Containers | `container_start`, `container_stop`, `container_restart`, `container_delete`, `container_logs` | Implemented |
| Container public URL | `container_tunnel_start` | Implemented |
| Git and files | `discover_branches`, `sync`, `read_compose`, `read_dockerfile` | Implemented |
| Deployment | `deploy`, `build`, `stop` | Implemented for Compose and Dockerfile |
| Repository public URL | `tunnel_start`, `tunnel_stop` | Implemented |

## Supporting behavior

| Capability | Status |
| --- | --- |
| Firebase authenticated realtime queue listeners | Implemented with polling recovery |
| ETag leasing, lease renewal and repository/container locks | Implemented |
| Concurrency limits and graceful shutdown | Implemented |
| Heartbeat, claim token, ownership and sharing preservation | Implemented |
| Container inventory reconciliation and worker protection | Implemented |
| Git credentials and AES-256-GCM secret decryption | Implemented |
| Project environment parsing and precedence | Implemented with Python-compatible formats |
| Compose environment override | Implemented |
| Dockerfile environment and port mappings | Implemented |
| Compose and Dockerfile port-collision validation | Implemented |
| Per-service repository tunnels and direct-container tunnels | Implemented |
| Explicit tunnel error state and workspace `app_logs` | Implemented |
| Bounded command output and command-process cancellation | Implemented |

## Remaining production validation

These are operational validation tasks, not missing dashboard actions:

1. Claim a compiled Go worker in a non-production Firebase workspace.
2. Run the same public and private Git repository fixtures through Python and Go.
3. Deploy one Compose project and one Dockerfile project on isolated Docker hosts.
4. Verify environment precedence, port-collision errors and inventory records in the UI.
5. Open, reuse, reset and close repository and direct-container ngrok tunnels.
6. Cancel long jobs and verify leases, locks and final job states.
7. Restart both workers and confirm identity, ownership and stale-record cleanup.

## Known shared hardening work

Long Compose, image-build, Git and ngrok subprocesses are not interrupted in the
middle of execution; cancellation is finalized after those operations return.
This does not remove an operation from Go, but both runtimes should eventually
receive consistent subprocess cancellation and rollback tests. Command
allowlists and failed Dockerfile deployment rollback are also shared hardening
work rather than Go-only parity gaps.
