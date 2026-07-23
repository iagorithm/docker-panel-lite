# Rust Worker — Parity Tracker

Runtime: Rust  
Source: `services/worker-rust`  
Configuration: compiled at build time from the `worker_config` BuildKit secret

## Current milestone

- [x] Typed compiled configuration without runtime environment reads.
- [x] Safe `--check-config` validation.
- [x] Compatible persistent claim-token format and SHA-256 hash.
- [x] Multi-stage Alpine image with Docker, Compose, Git and ngrok.
- [ ] Firebase REST authentication and heartbeat.
- [ ] Realtime queue, polling recovery, leases and locks.
- [ ] The 18 shared Python/Go worker actions.
- [ ] Shared contract and integration tests.

Rust must not report itself online until Firebase queue execution is implemented.
