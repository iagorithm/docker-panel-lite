#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yaml}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
SERVICE="worker"
ALL_SERVICES=false
CLEAN=false
ASSUME_YES=false

usage() {
  cat <<'EOF'
Usage: scripts/ngrok-sessions.sh [--service worker|worker-go] [--all] [--clean] [--yes]

Lists ngrok agent processes tracked by Docker Panel workers. Tokens are never
read or printed. This reports local worker processes; compare with
https://dashboard.ngrok.com/agents for sessions running on other machines.

Options:
  --service NAME  Inspect one Compose service (default: worker)
  --all           Inspect worker and worker-go when they are running
  --clean         Stop tracked ngrok processes and remove all state/log files
  --yes           Skip the --clean confirmation (for automation)
  -h, --help      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      [[ $# -ge 2 ]] || { echo "--service requires a value" >&2; exit 2; }
      SERVICE="$2"
      shift 2
      ;;
    --all)
      ALL_SERVICES=true
      shift
      ;;
    --clean)
      CLEAN=true
      shift
      ;;
    --yes)
      ASSUME_YES=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$SERVICE" in
  worker|worker-go) ;;
  *) echo "Unsupported service '$SERVICE'. Use worker or worker-go." >&2; exit 2 ;;
esac

compose=(docker compose -f "$COMPOSE_FILE")
if [[ -f "$ENV_FILE" ]]; then
  compose+=(--env-file "$ENV_FILE")
fi

inspect_service() {
  local service="$1"
  local container_id
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    echo "$service: not running"
    return
  fi

  echo "$service:"
  "${compose[@]}" exec -T "$service" sh -c '
    root="${APP_DATA_DIR:-/app/data}/ngrok"
    if [ ! -d "$root" ]; then
      echo "  No ngrok state directory found."
      exit 0
    fi

    live=0
    stale=0
    total=0
    printf "  %-7s %-7s %-42s %s\n" "STATE" "PID" "PROJECT / ENDPOINT" "TARGET"
    for state_file in "$root"/*.json; do
      [ -f "$state_file" ] || continue
      total=$((total + 1))
      pid=$(sed -n "s/.*\"pid\": *\([0-9][0-9]*\).*/\1/p" "$state_file" | head -n 1)
      target=$(sed -n "s/.*\"target\": *\"\([^\"]*\)\".*/\1/p" "$state_file" | head -n 1)
      url=$(sed -n "s/.*\"url\": *\"\([^\"]*\)\".*/\1/p" "$state_file" | head -n 1)
      name=$(basename "$state_file" .json)
      status=stale
      if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr "\000" " " < "/proc/$pid/cmdline" | grep -q "ngrok"; then
        status=live
        live=$((live + 1))
      else
        stale=$((stale + 1))
      fi
      printf "  %-7s %-7s %-42s %s\n" "$status" "${pid:--}" "$name" "${target:--}"
      [ -z "$url" ] || printf "          URL: %s\n" "$url"
    done
    if [ "$total" -eq 0 ]; then
      echo "  No tracked ngrok sessions."
    fi
    printf "  Total: %s | Active: %s | Stale: %s\n" "$total" "$live" "$stale"
  '
}

clean_service() {
  local service="$1"
  local container_id
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    echo "$service: not running; nothing was changed"
    return
  fi

  echo "$service: cleaning ngrok processes and local state"
  "${compose[@]}" exec -T "$service" sh -c '
    root="${APP_DATA_DIR:-/app/data}/ngrok"
    if [ ! -d "$root" ]; then
      echo "  No ngrok state directory found."
      exit 0
    fi

    stopped=0
    for state_file in "$root"/*.json; do
      [ -f "$state_file" ] || continue
      pid=$(sed -n "s/.*\"pid\": *\([0-9][0-9]*\).*/\1/p" "$state_file" | head -n 1)
      if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr "\000" " " < "/proc/$pid/cmdline" | grep -q "ngrok"; then
        kill "$pid" 2>/dev/null || true
        stopped=$((stopped + 1))
      fi
    done

    attempts=0
    while [ "$attempts" -lt 25 ]; do
      remaining=0
      for state_file in "$root"/*.json; do
        [ -f "$state_file" ] || continue
        pid=$(sed -n "s/.*\"pid\": *\([0-9][0-9]*\).*/\1/p" "$state_file" | head -n 1)
        if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr "\000" " " < "/proc/$pid/cmdline" | grep -q "ngrok"; then
          remaining=$((remaining + 1))
        fi
      done
      [ "$remaining" -eq 0 ] && break
      sleep 0.2
      attempts=$((attempts + 1))
    done

    for state_file in "$root"/*.json; do
      [ -f "$state_file" ] || continue
      pid=$(sed -n "s/.*\"pid\": *\([0-9][0-9]*\).*/\1/p" "$state_file" | head -n 1)
      if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr "\000" " " < "/proc/$pid/cmdline" | grep -q "ngrok"; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done

    removed=$(find "$root" -maxdepth 1 -type f \( -name "*.json" -o -name "*.log" \) -print | wc -l | tr -d " ")
    find "$root" -maxdepth 1 -type f \( -name "*.json" -o -name "*.log" \) -delete
    printf "  Stopped: %s | Removed state/log files: %s\n" "$stopped" "$removed"
  '
}

if [[ "$CLEAN" == true ]]; then
  if [[ "$ASSUME_YES" != true ]]; then
    if [[ ! -t 0 ]]; then
      echo "--clean requires an interactive confirmation or --yes" >&2
      exit 2
    fi
    echo "This stops all tracked ngrok processes and removes every local ngrok state/log file."
    echo "It does not clear Public URL values already stored in the panel database."
    read -r -p "Type CLEAN to continue: " confirmation
    [[ "$confirmation" == "CLEAN" ]] || { echo "Cancelled."; exit 0; }
  fi
  if [[ "$ALL_SERVICES" == true ]]; then
    clean_service worker
    clean_service worker-go
  else
    clean_service "$SERVICE"
  fi
  echo
fi

if [[ "$ALL_SERVICES" == true ]]; then
  inspect_service worker
  inspect_service worker-go
else
  inspect_service "$SERVICE"
fi
