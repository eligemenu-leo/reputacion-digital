#!/usr/bin/env bash
# Recrea una base de datos de pruebas local aplicando el shim de Supabase y
# todas las migraciones en orden. Uso: DATABASE_URL=postgres://... scripts/db-reset-test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_URL="${TEST_DATABASE_ADMIN_URL:-postgres://postgres@localhost:54329/postgres}"
DB_NAME="${TEST_DATABASE_NAME:-reputacion_test}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME"
DB_URL="${ADMIN_URL%/*}/$DB_NAME"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/supabase_shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "OK: $DB_URL"
