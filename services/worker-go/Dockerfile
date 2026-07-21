# syntax=docker/dockerfile:1.7
FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY services/worker-go/go.mod ./go.mod
RUN go mod download
COPY services/worker-go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/docker-panel-worker ./cmd/worker

FROM alpine:3.22
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose curl
WORKDIR /app
COPY --from=builder /out/docker-panel-worker /usr/local/bin/docker-panel-worker
ENV APP_DATA_DIR=/app/data APP_CLONE_DIR=/app/clones
CMD ["docker-panel-worker"]
