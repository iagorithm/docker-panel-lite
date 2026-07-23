# Rust Worker — Parity Tracker

Runtime: Rust  
Source: `services/worker-rust`  
Configuration: compiled at build time from the `worker_config` BuildKit secret

## Current implementation

- [x] Typed compiled configuration without runtime environment reads.
- [x] Safe `--check-config` validation.
- [x] Compatible persistent claim-token format and SHA-256 hash.
- [x] Multi-stage Alpine image with Docker, Compose, Git and ngrok.
- [x] Firebase REST authentication, ETags, retries and heartbeat.
- [x] Polling queue, atomic claims, leases and repository/container locks.
- [x] Dispatch for the 18 shared Python/Go worker actions.
- [x] Docker container inventory and protected worker-container actions.
- [x] Reproducible dependency resolution through `Cargo.lock`.
- [ ] Firebase realtime/SSE queue wakeups; polling is the recovery and current primary path.
- [ ] Cross-runtime fixtures for encrypted credentials, cancellation and multi-service tunnels.
- [ ] Shared contract and integration tests.

Rust reports itself online only after Firebase authentication and its first heartbeat succeed.
