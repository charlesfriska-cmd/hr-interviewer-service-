#!/usr/bin/env bash
# Starts a local Postgres for development and tests.
# Tests create and migrate their own database per file; this only provides the cluster.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/var/lib/postgresql/hrsvc}
PORT=${PORT:-55432}

if [ ! -d "$PGDATA/base" ]; then
  mkdir -p "$PGDATA"; chown -R postgres:postgres "$PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA -U hrsvc --auth=trust"
fi
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k /tmp' -l /tmp/pg.log start" || true
echo "postgres on port $PORT (socket /tmp)"
echo "export DATABASE_URL='postgresql://hrsvc@localhost/postgres?host=/tmp&port=$PORT'"
