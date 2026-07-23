# syntax=docker/dockerfile:1.7
FROM golang:1.24-alpine AS builder
ARG WORKER_VERSION=dev
ARG WORKER_COMMIT=unknown
ARG WORKER_BUILD_DATE=unknown
WORKDIR /src
COPY services/worker-go/go.mod ./go.mod
RUN go mod download
COPY services/worker-go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w \
      -X docker-panel-lite-worker-go/worker.WorkerVersion=${WORKER_VERSION} \
      -X docker-panel-lite-worker-go/worker.BuildCommit=${WORKER_COMMIT} \
      -X docker-panel-lite-worker-go/worker.BuildDate=${WORKER_BUILD_DATE}" \
    -o /out/docker-panel-worker ./worker

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
COPY --from=builder /out/docker-panel-worker /usr/local/bin/docker-panel-worker
CMD ["docker-panel-worker"]
