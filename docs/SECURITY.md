# Security Review

Last reviewed: 2026-07-21

This document is a practical security analysis of Docker Panel Lite as it exists in this repository. It focuses on the Next.js web app, Firebase Realtime Database rules, Firebase Admin usage, worker execution model, Docker access, credential storage, public URL exposure, and the legacy Streamlit app.

## Executive Summary

Docker Panel Lite is intentionally powerful: operators can connect Docker workers, clone repositories, build images, start containers, run commands, read logs, and expose public URLs. That makes the core security boundary the combination of Firebase authentication, custom claims, sharing rules, worker ownership, and the trust level of each worker host.

The most important risks are:

1. New authenticated users can become admins by default if custom claims are missing.
2. Operators can trigger remote command execution on workers and containers.
3. Workers mount the host Docker socket, which is effectively host-level control.
4. Worker images may embed Firebase service account credentials and encryption keys.
5. Repository builds execute untrusted Dockerfiles or Compose files on trusted hosts.

## Scope

Reviewed files and areas:

- `apps/web/app/actions.ts`
- `apps/web/app/api/*/route.ts`
- `apps/web/lib/session.ts`
- `apps/web/lib/firebase-admin.ts`
- `apps/web/lib/secrets.ts`
- `apps/web/lib/*-access.ts`
- `scripts/database.rules.json`
- `services/worker/worker/*`
- `services/worker/worker/core/*`
- `docker-compose.yaml`
- `scripts/publish-worker-image.sh`
- `.env.example`
- `streamlit/*`

## Findings

### Critical: Missing custom claims fall back to admin

Evidence:

- `apps/web/lib/session.ts` uses `DEFAULT_USER_ROLE || "admin"`.
- `.env.example` sets `DEFAULT_USER_ROLE=admin`.
- `docker-compose.yaml` defaults `DEFAULT_USER_ROLE` to `admin`.

Impact:

Any valid Firebase-authenticated user whose token does not contain a `role` claim can receive admin behavior from the server session. Admins can manage credentials, and operators/admins can enqueue jobs against workers. If Firebase Auth sign-up is open or a user is accidentally missing custom claims, this can become privilege escalation.

Recommended fix:

- Change the default role to `viewer` or deny access when `claims.role` is missing.
- Require `claims.workspaceId` and `claims.role` for dashboard access.
- Remove `DEFAULT_USER_ROLE=admin` from examples and compose defaults.
- Add a deployment check that fails startup when `DEFAULT_USER_ROLE=admin` in production.

Suggested policy:

```ts
if (!claims.role || !claims.workspaceId) return null;
```

### Critical: Operators can run arbitrary commands on workers and containers

Evidence:

- `apps/web/app/actions.ts` exposes `enqueueWorkerCommand` and `enqueueContainerCommand` to `requireSession("operator")`.
- `services/worker/worker/executor.py` runs worker commands with `subprocess.run(args, cwd=path, env=os.environ | environment)`.
- `services/worker/worker/executor.py` runs container commands through `/bin/sh -lc`.

Impact:

Any operator with access to a worker can execute commands on that worker or inside managed containers. Because the worker has Docker access and repository environment variables, this can expose secrets, modify deployments, alter files in clone/data directories, or interact with Docker.

Recommended fix:

- Move arbitrary command execution behind `admin`, not `operator`.
- Replace free-form worker commands with allowlisted command presets.
- Store command presets as admin-managed records and make operators execute only approved IDs.
- Add audit logs containing requester, worker, command ID, target container/repository, timestamp, and result.
- Consider disabling `worker_command` entirely by default with an env flag.

### Critical: Worker Docker socket mount gives host-level control

Evidence:

- `docker-compose.yaml` mounts `/var/run/docker.sock:/var/run/docker.sock`.
- Worker setup docs and Docker run commands mount the Docker socket.
- Worker uses Docker SDK and Docker CLI to build, run, stop, remove, inspect, and exec containers.

Impact:

Access to the Docker socket is equivalent to high privilege on the host in most deployments. A compromised worker, malicious repository build, or abused worker command can control containers and may be able to escape into host-level impact.

Recommended fix:

- Run workers only on dedicated hosts with no unrelated workloads.
- Treat workers as privileged infrastructure and never public/share them broadly.
- Consider a Docker socket proxy that allowlists only required API operations.
- Run the worker with least filesystem access and separate Docker contexts where possible.
- Document worker sharing as equivalent to granting deployment authority on that host.

### High: Baked worker images can contain long-lived secrets

Evidence:

- `scripts/publish-worker-image.sh` supports `WORKER_BAKE_CONFIG=true`.
- The baked config can include `FIREBASE_SERVICE_ACCOUNT_JSON`, `CREDENTIAL_ENCRYPTION_KEY`, `NGROK_AUTHTOKEN`, and Firebase database settings.
- `docs/WORKER_DOCKER_HUB.md` states baked config is intended for private images only.

Impact:

If the worker image is pushed to the wrong Docker Hub repository, shared with the wrong account, cached in CI, or pulled by an unauthorized host, it may expose Firebase Admin credentials and the encryption key needed to decrypt stored secrets.

Recommended fix:

- Default `WORKER_BAKE_CONFIG=false`.
- Prefer runtime secrets via `--env-file`, Docker secrets, or platform secret stores.
- Use a Firebase service account with the narrowest possible permissions for workers.
- Rotate Firebase service account keys and `CREDENTIAL_ENCRYPTION_KEY` if a baked image is ever exposed.
- Publish explicit private runtime tags such as `:py` and `:go`; do not publish secret-bearing floating aliases.

### High: Untrusted repositories can execute code during build/deploy

Evidence:

- Workers clone repository URLs supplied through the panel.
- Compose deployments run `docker compose up -d --build`.
- Dockerfile deployments call Docker SDK `images.build`.
- Repository environment variables are written into `.env` and passed into compose/build runtime.

Impact:

A malicious repository, Dockerfile, Compose file, build script, or dependency install step can execute code on the worker host during build. With Docker socket access, this is a major trust boundary.

Recommended fix:

- Only deploy repositories trusted by the worker owner.
- Require explicit approval before deploying a newly registered repository to a worker.
- Add repository allowlists per worker or per workspace.
- Consider scanning Compose/Dockerfile content for privileged flags, host mounts, host networking, and Docker socket mounts before deployment.
- Run builds in isolated builders or disposable workers where possible.

### High: Public worker/repository/credential sharing can grant broad operational access

Evidence:

- Workers, repositories, and credentials support `private`, `shared`, and `public`.
- Public credentials are accessible to any user in the workspace.
- Public workers can be used by any workspace user with sufficient role.

Impact:

Sharing is powerful and easy to overuse. A public credential plus public repository plus public worker can let many users deploy code and access runtime outputs. This may be correct for trusted internal teams, but it is risky for mixed-trust workspaces.

Recommended fix:

- Make `public` sharing admin-only for credentials and workers.
- Add confirmation dialogs explaining the blast radius.
- Show an audit trail for sharing changes.
- Prefer email-based sharing over workspace-public defaults.

### Medium: CSRF protection relies mainly on SameSite cookies

Evidence:

- Session cookie uses `sameSite: "lax"`.
- Server actions mutate state using cookie-based session authentication.
- No explicit CSRF token was found for state-changing forms/actions.

Impact:

`SameSite=Lax` blocks many cross-site POST cases, but relying only on browser cookie policy leaves less defense in depth. If browser behavior, same-site subdomains, or future endpoints change, state-changing actions may be easier to abuse.

Recommended fix:

- Add CSRF tokens to state-changing forms and API routes.
- Validate `Origin` / `Referer` for mutation endpoints.
- Keep `SameSite=Lax` or `Strict` for the session cookie.

### Medium: Session cookie `secure` depends on request protocol

Evidence:

- `apps/web/app/api/session/route.ts` sets `secure: requestUsesHttps(request)`.

Impact:

This supports local or HTTP Docker deployments, but it means production deployments behind a misconfigured proxy may issue non-secure cookies. Session cookies on plain HTTP can be intercepted on the network.

Recommended fix:

- Add `SESSION_COOKIE_SECURE=true` for production and fail closed when enabled.
- Trust `x-forwarded-proto` only from known reverse proxies.
- Document that production must run behind HTTPS.

### Medium: Firebase Realtime Database read rules expose all workspace metadata to workspace users

Evidence:

- `scripts/database.rules.json` allows any authenticated user with matching `workspaceId` to read `repositories`, `credentials`, `containers`, `deployments`, and `commandPresets`.
- The server API filters resources by owner/sharing before returning them, but client Firebase subscriptions may still read broad workspace paths if used directly.

Impact:

Client-side code could read metadata for resources the UI intends to hide, depending on how Firebase client subscriptions are structured. Secrets are protected under `/secrets`, but metadata such as aliases, masks, container names, ports, public URLs, and deployment messages can leak within a workspace.

Recommended fix:

- Move fine-grained read access into Firebase rules where possible.
- Avoid client subscriptions to broad workspace paths for sensitive resource types.
- Continue using server-filtered APIs for shared resources.
- Keep secrets only under `/secrets` with read/write denied to clients.

### Medium: Worker claim token is printed to logs

Evidence:

- `services/worker/worker/main.py` logs the claim token on startup.
- Claim token hash is stored in Firebase; raw token remains in local logs.

Impact:

Anyone with access to worker logs before claim can claim that worker. After claim, ownership checks prevent takeover, but leaked logs are still sensitive operational material.

Recommended fix:

- Print the token only while unclaimed, or print it once with a short TTL.
- Add a command to rotate the worker claim token.
- Redact token from logs after successful claim.
- Restrict log access on worker hosts.

### Medium: Legacy Streamlit app uses weak password hashing

Evidence:

- `streamlit/core/store.py` stores local admin password hashes as `sha256(salt + password)`.

Impact:

If the legacy `admin.json` file is exposed, offline password cracking is easier than with a password hashing algorithm designed for credentials.

Recommended fix:

- Replace SHA-256 with Argon2id, bcrypt, or scrypt.
- Store work factor parameters with the hash.
- Consider marking Streamlit as legacy/deprecated if the Next/Firebase app is now primary.

### Low: Dependency versions are broad and no lockfile is present in the repo

Evidence:

- `apps/web/package.json` uses broad ranges such as `next: ^16.0.0`.
- `services/worker/requirements.txt` uses broad ranges.
- No package lockfile was observed in the repository listing.

Impact:

Builds may resolve different dependency versions over time. This can introduce unexpected vulnerabilities or behavior changes.

Recommended fix:

- Commit `package-lock.json` or another lockfile for the web app.
- Use pinned Python dependency lock files for worker and Streamlit.
- Run `npm audit`, `pip-audit`, or equivalent dependency scanning in CI.

## Positive Controls Already Present

- Firebase RTDB rules deny client reads/writes to `/secrets`, `/jobs`, `/queues`, and `/locks`.
- Credentials and ngrok tokens are encrypted with AES-256-GCM before storage.
- Worker claim tokens are hashed in Firebase instead of storing raw tokens.
- Worker containers are protected from stop/delete/exec in both web actions and worker execution logic.
- Repository file paths for Compose and Dockerfile are validated to stay inside the clone directory.
- Git token values are sanitized from Git error output.
- Shared resource APIs sanitize inaccessible credential references.

## Recommended Priority Plan

1. Change missing-claim behavior from admin fallback to deny or viewer.
2. Restrict arbitrary worker/container commands to admins or allowlisted presets.
3. Disable baked worker secrets by default and rotate secrets if any image was public or widely shared.
4. Add mutation CSRF protection and origin checks.
5. Tighten Firebase read rules or remove broad client subscriptions for sensitive metadata.
6. Add audit logging for claim, sharing changes, credential changes, repository deploys, command execution, and public URL creation.
7. Add dependency lockfiles and automated dependency/security scanning.

## Operational Hardening Checklist

- Production uses HTTPS only.
- Firebase Auth sign-up is restricted or invitation-based.
- Every user has explicit `role` and `workspaceId` custom claims.
- `DEFAULT_USER_ROLE` is not `admin` in production.
- Worker hosts are dedicated and treated as privileged.
- Worker images with baked config are private, immutable, and access-controlled.
- Docker Hub, GitHub, Firebase, ngrok, and encryption keys have rotation procedures.
- Credentials are shared only with explicit users, not public, unless intentionally workspace-wide.
- Public workers are avoided unless the workspace is fully trusted.
- Public URLs are reviewed and closed when no longer needed.
- Logs are treated as sensitive because they may contain operational details and claim tokens.
