#!/bin/sh
set -e

mkdir -p /app/logs
chown -R "${AUTOCERT_UID:-10001}:${AUTOCERT_GID:-10001}" /app/logs

exec gosu autocert "$@"
