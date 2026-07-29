#!/bin/sh
# Tears the development stack down. Data volumes survive unless --volumes is
# passed explicitly and confirmed.
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/dev-down.sh [options]

Stops and removes the Docker Compose stack. Named volumes (Postgres, Redis,
Mongo data) are preserved by default.

Options:
      --volumes    ALSO delete the named volumes. This destroys all local
                   database data and cannot be undone.
      --yes        Skip the interactive confirmation for --volumes.
  -h, --help       Show this help.
USAGE
}

remove_volumes=0
assume_yes=0

while [ $# -gt 0 ]; do
  case $1 in
    --volumes) remove_volumes=1 ;;
    --yes | -y) assume_yes=1 ;;
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

cd "$PROJECT_ROOT"

if [ "$remove_volumes" -eq 0 ]; then
  log 'stopping the stack (volumes preserved)'
  compose down --remove-orphans
  log 'stack stopped'
  exit 0
fi

if [ "$assume_yes" -eq 0 ]; then
  if [ ! -t 0 ]; then
    die '--volumes requires --yes when stdin is not a terminal'
  fi
  printf 'This deletes ALL local database data. Type "delete" to continue: ' >&2
  read -r confirmation
  [ "$confirmation" = 'delete' ] || die 'aborted'
fi

log 'stopping the stack and removing volumes'
compose down --volumes --remove-orphans
log 'stack stopped and volumes removed'
