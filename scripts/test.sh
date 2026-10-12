#!/bin/sh
# Runs the backend and web client test suites. Dependencies must be installed.
set -eu
cd "$(dirname -- "$0")/.."
(cd backend && npm test)
(cd frontend && npm test)
