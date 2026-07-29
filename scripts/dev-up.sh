#!/bin/sh
# Brings the development stack up and waits until the API reports readiness.
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/dev-up.sh [options]

Builds (when needed) and starts the whole Docker Compose stack, then blocks
until the API answers on /health/ready.

Options:
  -b, --build           Force a rebuild of the API image before starting.
  -t, --timeout <secs>  Readiness timeout in seconds (default: 180).
      --no-wait         Start the stack and return without waiting.
  -h, --help            Show this help.

Environment:
  Values are read from ./.env (never from this script). PORT selects the port
  polled for readiness and defaults to 3000.
USAGE
}

force_build=0
wait_for_ready=1
timeout_seconds=180

while [ $# -gt 0 ]; do
  case $1 in
    -b | --build) force_build=1 ;;
    --no-wait) wait_for_ready=0 ;;
    -t | --timeout)
      [ $# -ge 2 ] || die 'missing value for --timeout'
      shift
      timeout_seconds=$1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

case $timeout_seconds in
  '' | *[!0-9]*) die "--timeout expects a positive integer, got: $timeout_seconds" ;;
esac

cd "$PROJECT_ROOT"

if [ ! -f .env ]; then
  die '.env is missing; copy .env.example to .env and fill in the secrets first'
fi

if [ "$force_build" -eq 1 ]; then
  log 'building images'
  compose build
fi

log 'starting the stack'
compose up -d

if [ "$wait_for_ready" -eq 0 ]; then
  log 'stack started (readiness wait skipped)'
  exit 0
fi

ready_url="$(api_base_url)/health/ready"
attempts=$((timeout_seconds / 2))
[ "$attempts" -ge 1 ] || attempts=1

if wait_for_http "$ready_url" "$attempts" 2; then
  log "stack is ready: $(api_base_url)"
  log "API docs: $(api_base_url)/docs"
  exit 0
fi

log 'the API did not become ready in time; recent logs follow'
compose logs --tail 50 api >&2 || true
die "readiness timed out after ${timeout_seconds}s"
