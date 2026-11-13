import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Recrea la base de datos de pruebas (shim Supabase + migraciones).
 * Requiere un PostgreSQL ≥ 15 accesible en TEST_DATABASE_ADMIN_URL.
 */
export default function setup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  execFileSync(path.join(root, 'scripts/db-reset-test.sh'), { stdio: 'inherit', env: process.env });
}
