#!/bin/sh
# Tails the logs of one (or all) Compose services.
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/logs.sh [options] [service]

Streams Docker Compose logs. Without a service name, logs of every service in
the stack are merged.

Arguments:
  service            Compose service, e.g. api, postgres, redis, mongo, migrate.

Options:
  -n, --tail <n>     Number of trailing lines to show first (default: 100).
      --no-follow    Print the buffered lines and exit instead of streaming.
  -l, --list         List the services defined in the stack and exit.
  -h, --help         Show this help.
USAGE
}

tail_lines=100
follow=1
service=''

while [ $# -gt 0 ]; do
  case $1 in
    -n | --tail)
      [ $# -ge 2 ] || die 'missing value for --tail'
      shift
      tail_lines=$1
      ;;
    --no-follow) follow=0 ;;
    -l | --list)
      cd "$PROJECT_ROOT"
      compose config --services
      exit 0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      die "unknown option: $1"
      ;;
    *)
      [ -z "$service" ] || die 'only one service may be given'
      service=$1
      ;;
  esac
  shift
done

case $tail_lines in
  all) ;;
  '' | *[!0-9]*) die "--tail expects a positive integer or 'all', got: $tail_lines" ;;
esac

cd "$PROJECT_ROOT"

if [ -n "$service" ]; then
  if ! compose config --services | grep -qx -- "$service"; then
    log 'available services:'
    compose config --services >&2
    die "unknown service: $service"
  fi
fi

if [ "$follow" -eq 1 ]; then
  # shellcheck disable=SC2086
  compose logs --follow --tail "$tail_lines" $service
else
  # shellcheck disable=SC2086
  compose logs --tail "$tail_lines" $service
fi
