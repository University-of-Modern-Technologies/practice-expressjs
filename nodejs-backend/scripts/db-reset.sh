#!/bin/sh
# Drops, re-migrates and re-seeds the development database.
# Refuses to run against a production environment.
set -eu

. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/db-reset.sh [options]

Resets the development database: drops the schema, replays all migrations and
runs the seed script. Existing data is lost.

Options:
      --skip-seed   Reset and migrate, but do not seed.
      --yes         Skip the interactive confirmation.
  -h, --help        Show this help.

Safety:
  Aborts when NODE_ENV=production. Credentials are taken from DATABASE_URL in
  the environment or ./.env; nothing is hardcoded here.
USAGE
}

skip_seed=0
assume_yes=0

while [ $# -gt 0 ]; do
  case $1 in
    --skip-seed) skip_seed=1 ;;
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

node_env=${NODE_ENV:-$(env_value NODE_ENV development)}

if [ "$node_env" = 'production' ]; then
  die 'refusing to reset the database while NODE_ENV=production'
fi

require_command npm

if [ "$assume_yes" -eq 0 ]; then
  if [ ! -t 0 ]; then
    die 'confirmation required; re-run with --yes in a non-interactive shell'
  fi
  printf 'This erases the "%s" database. Type "reset" to continue: ' "$node_env" >&2
  read -r confirmation
  [ "$confirmation" = 'reset' ] || die 'aborted'
fi

log "resetting the ${node_env} database"
npm run prisma -- migrate reset --force --skip-seed --skip-generate

log 'generating the Prisma client'
npm run prisma:generate

if [ "$skip_seed" -eq 1 ]; then
  log 'database reset and migrated (seed skipped)'
  exit 0
fi

log 'seeding'
npm run db:seed

log 'database reset, migrated and seeded'
