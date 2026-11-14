import postgres from 'postgres';
import type { Config } from '../config';
import type { AuthContext } from './auth';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export function createDb(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): Sql {
  return postgres(config.DATABASE_URL, {
    max: config.DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // compatible con el pooler de Supabase (modo transacción)
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel }, undefined: null },
    onnotice: () => {},
  });
}

function claimsJson(auth: AuthContext): string {
  return JSON.stringify({
    sub: auth.userId,
    role: 'authenticated',
    email: auth.email,
    aal: auth.aal,
  });
}

/**
 * Ejecuta `fn` como el usuario autenticado: rol `authenticated` + claims JWT.
 * Todas las políticas RLS se aplican. Es la vía por defecto.
 */
export async function withUser<T>(
  sql: Sql,
  auth: AuthContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsJson(auth)}, true)`;
    await tx.unsafe('set local role authenticated');
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Ejecuta `fn` como service_role (RLS desactivado). SOLO tras comprobar
 * autorización explícita en código. Conserva el actor para la auditoría.
 */
export async function withService<T>(
  sql: Sql,
  actor: AuthContext | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    if (actor) await tx`select set_config('request.jwt.claims', ${claimsJson(actor)}, true)`;
    await tx.unsafe('set local role service_role');
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Dentro de una transacción withUser, y SOLO después de comprobar permisos en
 * código, pasa a service_role para escribir en tablas de flujo que el rol
 * `authenticated` solo puede leer. Las claims (actor) se conservan para la auditoría.
 */
export async function elevate(tx: Tx): Promise<void> {
  await tx.unsafe('set local role service_role');
}
