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
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose curl
WORKDIR /app
COPY --from=builder /out/docker-panel-worker /usr/local/bin/docker-panel-worker
CMD ["docker-panel-worker"]
