# Configure Domains and HTTPS for Docker Containers on a VPS

This guide explains how to expose Docker Control Panel and the applications it manages using:

- An Ubuntu 24.04 LTS VPS.
- Docker Engine and Docker Compose.
- Traefik as the reverse proxy.
- Let's Encrypt for automatic HTTPS certificates.
- A domain managed by any DNS provider.

The final architecture is:

```text
Internet
   │
   ├── panel.example.com ──────┐
   ├── crm.example.com ────────┼── Traefik :80/:443 ── Docker `proxy` network
   └── youtube.example.com ────┘                            │
                                                           ├── panel:8501
                                                           ├── crm:8080
                                                           └── youtube:3000
```

Traefik is the only container that publishes ports `80` and `443` on the VPS. Application ports remain private inside Docker.

## 1. Values you must define

Replace these placeholders throughout the examples:

| Example value | Replace with |
| --- | --- |
| `example.com` | Your actual domain |
| `panel.example.com` | The panel domain |
| `crm.example.com` | An application domain |
| `VPS_IP_ADDRESS` | The public IPv4 address of the VPS |
| `admin@example.com` | Email address for Let's Encrypt |
| `THIS_REPOSITORY_URL` | Git URL for Docker Control Panel |

You need SSH access with a user that can run `sudo`.

## 2. Configure DNS

Create an `A` record for each hostname in your DNS provider:

```text
Type  Name      Destination
A     panel     VPS_IP_ADDRESS
A     crm       VPS_IP_ADDRESS
A     youtube   VPS_IP_ADDRESS
```

You can optionally create a wildcard record:

```text
A     *.apps    VPS_IP_ADDRESS
```

This lets you use names such as `crm.apps.example.com` and `youtube.apps.example.com` without creating a separate DNS record for every application.

Check DNS propagation:

```bash
dig +short panel.example.com
dig +short crm.example.com
```

Both commands must return `VPS_IP_ADDRESS` before Traefik requests a certificate.

> A wildcard DNS record does not automatically provide a wildcard TLS certificate. The HTTP Challenge configuration in this guide issues an individual certificate for every hostname. A true wildcard certificate requires DNS Challenge support from your DNS provider.

## 3. Prepare the VPS

Update the operating system:

```bash
sudo apt update
sudo apt upgrade -y
```

Configure the firewall without closing your current SSH session:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Only SSH, HTTP, and HTTPS should be publicly accessible. Do not publish internal application ports directly.

> Docker can create firewall rules that bypass some UFW restrictions when a container publishes a port. This architecture publishes only Traefik's `80:80` and `443:443` mappings. See Docker's firewall warning in the official references at the end of this guide.

## 4. Install Docker Engine

Add Docker's official package repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Create the repository definition:

```bash
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

Install Docker and the Compose plugin:

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
docker compose version
```

Optionally allow your user to run Docker without `sudo`:

```bash
sudo usermod -aG docker "$USER"
```

Close and reopen the SSH session to apply the group membership. Membership in the `docker` group is effectively administrative access to the VPS. Do not add untrusted users.

## 5. Clone Docker Control Panel

Clone this repository on the VPS. Traefik will be added to the panel's existing Compose file, so there is only one Compose project to operate:

```bash
cd /opt
sudo git clone THIS_REPOSITORY_URL docker-panel-lite
cd /opt/docker-panel-lite/streamlit
```

Create the local directory and file used for Let's Encrypt certificates:

```bash
mkdir -p traefik/letsencrypt
touch traefik/letsencrypt/acme.json
chmod 600 traefik/letsencrypt/acme.json
```

The `traefik/letsencrypt/` directory contains runtime data and must be added to `.gitignore`.

Add these entries to `streamlit/.gitignore`:

```gitignore
.env
/traefik/letsencrypt/
```

## 6. Configure one Compose stack

Create a local `.env` file next to `streamlit/docker-compose.yaml`:

```dotenv
PANEL_DOMAIN=panel.example.com
LETSENCRYPT_EMAIL=admin@example.com
```

Do not commit this `.env` file. Replace both values with your real hostname and email address.

Update `streamlit/docker-compose.yaml` so it contains both Traefik and Docker Control Panel:

```yaml
services:
  traefik:
    image: traefik:v3.6
    container_name: traefik
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=proxy

      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443

      - --certificatesresolvers.letsencrypt.acme.email=${LETSENCRYPT_EMAIL}
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web

      - --api.dashboard=false
      - --log.level=INFO
      - --accesslog=true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/letsencrypt:/letsencrypt
    networks:
      - proxy

  streamlit-panel:
    build: .
    restart: unless-stopped
    expose:
      - "8501"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
      - ./repos:/app/clones
      - ./app.py:/app/app.py
      - ./core:/app/core
      - ./ui:/app/ui
      - ./.streamlit:/app/.streamlit
      - ./requirements.txt:/app/requirements.txt
    environment:
      - APP_DATA_DIR=/app/data
      - APP_CLONE_DIR=/app/clones
    networks:
      - default
      - proxy
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.docker-panel.rule=Host(`${PANEL_DOMAIN}`)
      - traefik.http.routers.docker-panel.entrypoints=websecure
      - traefik.http.routers.docker-panel.tls=true
      - traefik.http.routers.docker-panel.tls.certresolver=letsencrypt
      - traefik.http.services.docker-panel.loadbalancer.server.port=8501

networks:
  proxy:
    name: proxy
```

This single Compose file creates a Docker network named exactly `proxy`. Compose projects deployed later by the panel can join that network by declaring it as external.

If the current Compose file contains this public port mapping:

```yaml
ports:
  - "8501:8501"
```

remove it in production and use `expose: ["8501"]`. The panel will then be reachable only through Traefik over HTTPS.

Do not expose the Traefik dashboard publicly without authentication.

## 7. Start the complete platform

Start Traefik and the panel together with one command:

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100 traefik streamlit-panel
```

This is the only platform-level Compose command you need. It creates the shared `proxy` network automatically and starts both services in the same project.

Open:

```text
https://panel.example.com
```

## 8. Expose a Docker Compose application

Connect only the application's public HTTP service to `proxy`. Databases, queues, and internal workers should remain on the project's private default network.

Example for a CRM application listening internally on port `8080`:

```yaml
services:
  web:
    build: .
    restart: unless-stopped
    expose:
      - "8080"
    networks:
      - default
      - proxy
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.crm.rule=Host(`crm.example.com`)
      - traefik.http.routers.crm.entrypoints=websecure
      - traefik.http.routers.crm.tls=true
      - traefik.http.routers.crm.tls.certresolver=letsencrypt
      - traefik.http.services.crm.loadbalancer.server.port=8080

  database:
    image: postgres:17
    restart: unless-stopped
    networks:
      - default
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}

networks:
  proxy:
    external: true

volumes:
  postgres_data:
```

Replace:

- `crm.example.com` with the actual hostname.
- `crm` with a unique Traefik router and service identifier.
- `8080` with the application's real internal HTTP port.

Never reuse the same Traefik router name across projects.

### Environment variables and secrets

Do not commit passwords or tokens to Git. Reference variables in Compose:

```yaml
environment:
  DATABASE_URL: ${DATABASE_URL}
```

Set the value from Docker Control Panel or an ignored local `.env` file.

## 9. Deploy an application from the panel

For each repository:

1. Register the public or private repository.
2. Select the GitHub credential.
3. Load and select the deployment branch.
4. Enter the correct Compose file path.
5. Configure its environment variables.
6. Synchronize the repository.
7. Open the Compose viewer and confirm the Traefik labels.
8. Deploy the project.
9. Open its HTTPS hostname.

The panel uses a separate Compose project name for each repository. The shared `proxy` network must be declared with `external: true`. Otherwise, Compose creates an isolated network that Traefik cannot use.

## 10. Repositories that only contain a Dockerfile

The panel currently creates Dockerfile-based containers through the Docker SDK. To assign a domain, the container must also be created with:

- The external `proxy` network.
- `traefik.enable=true`.
- A `Host(...)` router rule.
- The application's internal HTTP port.
- The `letsencrypt` certificate resolver.

Until these settings are implemented in the Dockerfile deployment path, add a minimal Compose file around the Dockerfile:

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    expose:
      - "3000"
    networks:
      - proxy
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.my-app.rule=Host(`app.example.com`)
      - traefik.http.routers.my-app.entrypoints=websecure
      - traefik.http.routers.my-app.tls.certresolver=letsencrypt
      - traefik.http.services.my-app.loadbalancer.server.port=3000

networks:
  proxy:
    external: true
```

## 11. Validate the deployment

Check DNS and HTTPS:

```bash
dig +short crm.example.com
curl -I http://crm.example.com
curl -I https://crm.example.com
```

HTTP should redirect to HTTPS. Inspect the containers and shared network:

```bash
sudo docker ps
sudo docker network inspect proxy
sudo docker logs --tail=100 traefik
```

Confirm that Traefik and the application are connected to `proxy`:

```bash
sudo docker network inspect proxy --format '{{range .Containers}}{{println .Name}}{{end}}'
```

## 12. Troubleshooting

### Traefik returns `404 page not found`

Check:

- The container has `traefik.enable=true`.
- The hostname in `Host(...)` exactly matches the requested domain.
- Traefik and the application share the `proxy` network.
- `traefik.docker.network=proxy` is set.
- Router names are unique.

### Traefik returns `502 Bad Gateway`

Traefik found the router but cannot reach the application. Check:

- `loadbalancer.server.port` matches the internal application port.
- The application listens on `0.0.0.0`, not only `127.0.0.1`.
- The application container is healthy and not restarting.
- Both containers are connected to `proxy`.

### The TLS certificate is not issued

Check:

- DNS already resolves to the VPS.
- Ports `80` and `443` are open in both the VPS and cloud-provider firewalls.
- Nginx, Apache, or Caddy is not already using those ports.
- The Let's Encrypt email is correct.
- Traefik logs do not show an ACME error.

Useful commands:

```bash
sudo ss -lntp | grep -E ':80|:443'
cd /opt/docker-panel-lite/streamlit
sudo docker compose logs --tail=200 traefik
```

### The IP works but the hostname does not

Check DNS using public resolvers:

```bash
dig @1.1.1.1 +short crm.example.com
dig @8.8.8.8 +short crm.example.com
```

### Cloudflare reports too many redirects

Set Cloudflare SSL/TLS mode to `Full (strict)`. Do not use `Flexible`, because Traefik already redirects HTTP to HTTPS.

## 13. Security recommendations

- Protect the panel with a long, unique password.
- Consider restricting the panel hostname with a VPN, an IP allowlist, or an additional authentication layer.
- Never publish database ports to the public VPS interface.
- Never commit GitHub PATs, passwords, or `.env` files.
- Use expiring GitHub tokens with the minimum required permissions.
- Keep the public Traefik dashboard disabled.
- Treat Docker socket access as administrative access to the VPS.
- Only the panel and Traefik should access the Docker socket.
- Keep Ubuntu, Docker, Traefik, and application images updated.

## 14. Backups

Back up at least:

```text
/opt/docker-panel-lite/streamlit/traefik/letsencrypt/acme.json
/opt/docker-panel-lite/streamlit/data/
Docker volumes containing persistent application data
Local .env files that are not stored in Git
```

Example manual backup:

```bash
sudo tar -czf /root/docker-platform-backup-$(date +%F).tar.gz \
  /opt/docker-panel-lite/streamlit/traefik/letsencrypt \
  /opt/docker-panel-lite/streamlit/data
```

Store a copy outside the VPS. The archive contains certificates and secrets and must be protected.

## 15. Updates

Update Traefik and Docker Control Panel as one stack:

```bash
cd /opt/docker-panel-lite
sudo git pull --ff-only
cd streamlit
sudo docker compose pull
sudo docker compose up -d --build
sudo docker image prune
```

Review release notes before changing the major version of Docker or Traefik.

## 16. Final checklist

- [ ] DNS resolves to the public VPS IP.
- [ ] The firewall permits SSH, HTTP, and HTTPS.
- [ ] Docker Engine and Docker Compose are installed.
- [ ] The main Compose stack creates the named `proxy` network.
- [ ] Traefik is listening on ports `80` and `443`.
- [ ] `acme.json` has permission mode `600`.
- [ ] Docker Control Panel is connected to `proxy`.
- [ ] Every public service has Traefik labels.
- [ ] Internal services do not publish unnecessary ports.
- [ ] Every Traefik router has a unique name.
- [ ] Every HTTP application listens on `0.0.0.0`.
- [ ] HTTP redirects to HTTPS.
- [ ] HTTPS certificates are valid.
- [ ] Backups are configured and stored off-site.

## Official references

- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Traefik Docker routing configuration](https://doc.traefik.io/traefik/reference/routing-configuration/other-providers/docker/)
- [Traefik Docker Standalone setup](https://doc.traefik.io/traefik/v3.6/setup/docker/)
- [Traefik providers and `exposedByDefault`](https://doc.traefik.io/traefik/providers/overview/)
- [Ubuntu Server firewall documentation](https://documentation.ubuntu.com/server/how-to/security/firewalls/)
