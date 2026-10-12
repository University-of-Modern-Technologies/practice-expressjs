#!/bin/sh
# Drops, re-migrates and re-seeds the development database.
# Refuses to run against a production environment.
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

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

# Reads a variable from the backend .env, then from the shared one a level up,
# without sourcing either: values may contain characters that sh would interpret.
env_value() {
  value=$(
    for env_file in "$PROJECT_ROOT/.env" "$PROJECT_ROOT/../.env"; do
      if [ -f "$env_file" ]; then
        sed -n "s/^[[:space:]]*$1=//p" "$env_file" | tail -n 1
      fi
    done | head -n 1
  )
  value=${value%\"}
  value=${value#\"}
  printf '%s\n' "${value:-${2-}}"
}

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
  Aborts when APP_ENV=production. The database is the one the application
  would use: DATABASE_URL from the environment or ./.env, otherwise assembled
  from the POSTGRES_* values in ./.env and ../.env; nothing is hardcoded here.
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

app_env=${APP_ENV:-${NODE_ENV:-$(env_value APP_ENV "$(env_value NODE_ENV development)")}}

if [ "$app_env" = 'production' ]; then
  die 'refusing to reset the database while APP_ENV=production'
fi

require_command npm

if [ "$assume_yes" -eq 0 ]; then
  if [ ! -t 0 ]; then
    die 'confirmation required; re-run with --yes in a non-interactive shell'
  fi
  printf 'This erases the "%s" database. Type "reset" to continue: ' "$app_env" >&2
  read -r confirmation
  [ "$confirmation" = 'reset' ] || die 'aborted'
fi

log "resetting the ${app_env} database"
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
