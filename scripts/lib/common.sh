#!/bin/sh
# Shared helpers for the development scripts.
# Sourced, never executed directly. POSIX sh only.

set -eu

# Absolute path of the repository root, independent of the caller's cwd.
common_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$common_script_dir/.." && pwd)
export PROJECT_ROOT

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Resolves the compose entry point: the v2 plugin first, then the legacy binary.
compose() {
  require_command docker

  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die 'docker compose is not available'
  fi
}

# Reads a variable from .env without sourcing the file (values may contain
# characters that sh would interpret). Falls back to the provided default.
env_value() {
  key=$1
  fallback=${2-}
  value=$(
    if [ -f "$PROJECT_ROOT/.env" ]; then
      sed -n "s/^[[:space:]]*${key}=//p" "$PROJECT_ROOT/.env" | tail -n 1
    fi
  )
  value=${value%\"}
  value=${value#\"}

  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

api_base_url() {
  printf 'http://127.0.0.1:%s\n' "$(env_value PORT 3000)"
}

# Polls an HTTP endpoint until it answers with 2xx or the attempts run out.
wait_for_http() {
  url=$1
  attempts=${2:-60}
  interval=${3:-2}
  require_command curl

  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if curl --silent --fail --max-time 5 --output /dev/null "$url"; then
      return 0
    fi
    log "waiting for $url ($attempt/$attempts)"
    sleep "$interval"
    attempt=$((attempt + 1))
  done

  return 1
}
