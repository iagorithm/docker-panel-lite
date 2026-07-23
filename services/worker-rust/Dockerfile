# syntax=docker/dockerfile:1.7
FROM rust:1.88-alpine AS builder
ARG WORKER_CONFIG_REQUIRED=false
WORKDIR /src
RUN apk add --no-cache musl-dev
COPY services/worker-rust/Cargo.toml services/worker-rust/Cargo.lock services/worker-rust/build.rs ./
COPY services/worker-rust/src ./src
RUN --mount=type=secret,id=worker_config,required=false \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    if [ "$WORKER_CONFIG_REQUIRED" = "true" ] && [ ! -s /run/secrets/worker_config ]; then \
      echo "A worker_config BuildKit secret is required to compile the configured Rust worker." >&2; \
      exit 1; \
    fi \
    && cargo test --release --locked \
    && cargo build --release --locked \
    && cp target/release/worqer-worker-rust /out-worker

FROM alpine:3.22
ARG NGROK_VERSION=3
ARG TARGETARCH
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose curl \
    && case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) ngrok_arch="amd64" ;; \
      arm64|aarch64) ngrok_arch="arm64" ;; \
      arm|armv7l) ngrok_arch="arm" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v${NGROK_VERSION}-stable-linux-${ngrok_arch}.tgz" -o /tmp/ngrok.tgz \
    && tar xzf /tmp/ngrok.tgz -C /usr/local/bin ngrok \
    && chmod +x /usr/local/bin/ngrok \
    && rm -f /tmp/ngrok.tgz
WORKDIR /app
COPY --from=builder /out-worker /usr/local/bin/docker-panel-worker
ENTRYPOINT ["docker-panel-worker"]
