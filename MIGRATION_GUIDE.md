# Firebase Realtime + Next.js + Worker Migration Guide

This migration introduces a decoupled control plane:

- **Next.js** renders the UI, authenticates Firebase users, and performs privileged mutations through Server Actions.
- **Firebase Authentication** manages users. Custom claims carry `role` and `workspaceId`.
- **Firebase Realtime Database** distributes repository, deployment, worker, and queue state immediately.
- **Python workers** claim jobs with RTDB transactions, renew leases, enforce one active job per repository, and execute Git/Docker operations.
- **Public tunnels** expose selected running services for previews, callbacks, demos, and validation links.
Everything running on the VPS is defined in [docker-compose.yaml](docker-compose.yaml) at the repository root. Firebase remains the managed external state and authentication service.

## 1. Revoke the exposed GitHub token

The old Git history contained `streamlit/data/github_credentials.json`. Revoke that token in GitHub immediately and create a replacement at <https://github.com/settings/tokens/new>. Do not bypass GitHub push protection.

Runtime data, clones, caches, `.env` files, and service-account files are now ignored. Because `.gitignore` does not erase existing history, remove the leaked file from every affected commit before pushing.

## 2. Create Firebase resources

In one Firebase project:

1. Enable **Authentication > Sign-in method > Email/Password**.
2. Create the first user in **Authentication > Users**.
3. Create a **Realtime Database**. Choose the VPS region deliberately because queue latency depends on it.
4. Create a Firebase Web App and copy its client configuration.
5. In Google Cloud IAM, create a dedicated service account for this control plane and download its JSON key. Keep it outside Git.
6. Install the Firebase CLI and publish the rules from the repository root:

   ```bash
   firebase login
   firebase use YOUR_PROJECT_ID
   firebase deploy --only database
   ```

The browser may read only its own workspace. It cannot write repositories, jobs, queues, locks, or encrypted secrets directly. Firebase Admin in Next.js and the worker performs those writes.

## 3. Configure local/VPS secrets

From the repository root:

```bash
cp .env.example .env
openssl rand -base64 32
```

Put the generated value in `CREDENTIAL_ENCRYPTION_KEY`. Fill all Firebase values in `.env`. Convert the service-account file to one line before assigning `FIREBASE_SERVICE_ACCOUNT_JSON`, for example:

```bash
jq -c . /secure/path/firebase-service-account.json
```

Never commit `.env`, the JSON key, Firebase Admin credentials, or GitHub tokens. Back up `CREDENTIAL_ENCRYPTION_KEY` securely: losing it makes stored Git credentials unreadable.

## 4. Assign application claims

Install the web dependencies, then assign the first user to a workspace:

```bash
cd apps/web
npm install
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
  npm run set-user-claims -- admin@example.com admin default
cd ../..
```

Roles are:

- `viewer`: read-only realtime dashboard.
- `operator`: repository and deployment actions.
- `admin`: operator actions plus credential management.

The user must sign in again after claims change.

## 5. Validate and import Streamlit data

The import command defaults to a dry run. It maps `repos.json`, encrypts legacy credential tokens before upload, and never prints tokens:

```bash
docker compose --env-file .env -f docker-compose.yaml build worker

docker compose --env-file .env -f docker-compose.yaml run --rm worker \
  python /app/scripts/migrate_streamlit_data.py --data-dir /app/data
```

If the totals are correct, apply it:

```bash
docker compose --env-file .env -f docker-compose.yaml run --rm worker \
  python /app/scripts/migrate_streamlit_data.py --data-dir /app/data --apply
```

Existing RTDB records are preserved. Add `--overwrite` only when replacing them is intentional.

## 6. Configure DNS and domains

Point each application hostname to the VPS public IP using an `A` record (and `AAAA` when IPv6 is configured). Open inbound TCP ports `80` and `443` in the VPS firewall/security group.

The app controls **public URL metadata** for selected services. The worker connects the public tunnel to the running container/service and reports the generated URL back to Firebase. DNS records and reverse proxy routing are no longer managed by this stack.

## 7. Start the migration stack

Run all new services from the same Compose file:

```bash
docker compose --env-file .env -f docker-compose.yaml up -d --build
```

Open:

- Next.js control plane: `http://VPS_IP:3000`
- Routed applications: `https://configured-domain.example`

Inspect health and logs:

```bash
docker compose --env-file .env -f docker-compose.yaml ps
docker compose --env-file .env -f docker-compose.yaml logs -f web worker
```

## 8. Scale workers

Each repository hashes into one of 16 queue shards. Workers receive realtime queue events and also poll periodically so they can reclaim work after an expired lease. A distributed repository lock prevents concurrent deploy operations for the same repository.

On one VPS:

```bash
docker compose --env-file .env -f docker-compose.yaml up -d --scale worker=4
```

For multiple VPS nodes, use the same Firebase project, workspace, pool, encryption key, and shard count. Give each node a non-overlapping `WORKER_SHARDS` set when you want strict partitioning, for example `00,01,02,03`. Every node needs Docker access and persistent clone/data directories. Do not share a Docker socket across hosts.

`WORKER_MAX_CONCURRENCY` controls jobs within each worker process. Start conservatively because image builds are CPU, disk, and memory intensive.

## 9. Cut over safely

Before retiring Streamlit, verify:

- private and public repositories sync from an empty `repos` directory;
- branches can be discovered and the selected branch deploys;
- Compose and Dockerfile deployments work;
- domains obtain valid certificates and reach the expected internal port;
- stopping and redeploying works;
- jobs recover after forcibly restarting a worker;
- unauthorized users cannot see another workspace or save credentials.

Keep Firebase backups, `.env`, the encryption key, worker data, and repository clones in the VPS backup policy.
