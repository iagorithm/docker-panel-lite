# syntax=docker/dockerfile:1.7
FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY services/worker-go/go.mod ./go.mod
RUN go mod download
COPY services/worker-go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/docker-panel-worker ./worker

FROM alpine:3.22
ARG WORKER_CONFIG_REQUIRED=false
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose curl
WORKDIR /app
COPY --from=builder /out/docker-panel-worker /usr/local/bin/docker-panel-worker
RUN --mount=type=secret,id=worker_config,required=false \
    mkdir -p /app/config \
    && if [ -f /run/secrets/worker_config ]; then \
      cp /run/secrets/worker_config /app/config/worker.env; \
      chmod 600 /app/config/worker.env; \
    fi \
    && if [ "$WORKER_CONFIG_REQUIRED" = "true" ] && [ ! -s /app/config/worker.env ]; then \
      echo "Worker fallback configuration was required but was not embedded." >&2; \
      exit 1; \
    fi
ENV APP_DATA_DIR=/app/data APP_CLONE_DIR=/app/clones
CMD ["docker-panel-worker"]
