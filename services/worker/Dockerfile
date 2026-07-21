# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

ARG DOCKER_CLI_VERSION=27.3.1
ARG COMPOSE_VERSION=2.29.7
ARG NGROK_VERSION=3
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) docker_arch="x86_64"; compose_arch="x86_64"; ngrok_arch="amd64" ;; \
      arm64|aarch64) docker_arch="aarch64"; compose_arch="aarch64"; ngrok_arch="arm64" ;; \
      arm|armv7l) docker_arch="armhf"; compose_arch="armv7"; ngrok_arch="arm" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
    && tar xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
    && curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v${NGROK_VERSION}-stable-linux-${ngrok_arch}.tgz" -o /tmp/ngrok.tgz \
    && tar xzf /tmp/ngrok.tgz -C /usr/local/bin ngrok \
    && chmod +x /usr/local/bin/ngrok \
    && rm -rf /tmp/docker /tmp/docker.tgz /tmp/ngrok.tgz

WORKDIR /app
COPY services/worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/worker/worker ./worker
COPY services/worker/scripts ./scripts
RUN --mount=type=secret,id=worker_config,required=false \
    mkdir -p /app/config \
    && if [ -f /run/secrets/worker_config ]; then \
      cp /run/secrets/worker_config /app/config/worker.env; \
      chmod 600 /app/config/worker.env; \
    fi

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 WORKER_CONFIG_FILE=/app/config/worker.env
CMD ["python", "-m", "worker.main"]
