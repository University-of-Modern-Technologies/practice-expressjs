#!/bin/sh
# Development containers keep node_modules in a named volume, and Docker fills a
# named volume from the image only when it creates it. A dependency added later
# would never reach it, so the lock file is compared with the one the volume was
# installed from and the volume is brought up to date before the command runs.
set -eu
if ! cmp -s package-lock.json node_modules/.installed-lock; then
  echo "package-lock.json changed: installing dependencies into the volume"
  npm install --no-save --ignore-scripts --no-audit --no-fund
  cp package-lock.json node_modules/.installed-lock
fi
exec "$@"
