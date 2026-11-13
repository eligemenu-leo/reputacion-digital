/**
 * Crea (o promociona) el primer superadministrador de la plataforma.
 *
 *   pnpm --filter @rep/api bootstrap:superadmin -- --email admin@agencia.es [--password '...']
 *
 * Sin --password se envía una invitación por email (Supabase Auth). Requiere
 * DATABASE_URL, SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Idempotente.
 */
import postgres from 'postgres';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { email: { type: 'string' }, password: { type: 'string' } },
});
const email = values.email?.trim().toLowerCase();
if (!email) throw new Error('Uso: --email <email> [--password <contraseña>]');
const {
  DATABASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  APP_URL = 'http://localhost:5173',
} = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('Faltan DATABASE_URL, SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

try {
  let [user] = await sql<{ id: string }[]>`select id from auth.users where lower(email) = ${email}`;
  if (!user) {
    const base = SUPABASE_URL.replace(/\/$/, '');
    const res = values.password
      ? await fetch(`${base}/auth/v1/admin/users`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email, password: values.password, email_confirm: true }),
        })
      : await fetch(
          `${base}/auth/v1/invite?redirect_to=${encodeURIComponent(`${APP_URL}/auth/callback`)}`,
          { method: 'POST', headers, body: JSON.stringify({ email }) },
        );
    if (!res.ok) throw new Error(`Supabase Auth respondió HTTP ${res.status}: ${await res.text()}`);
    user = { id: ((await res.json()) as { id: string }).id };
    console.warn(values.password ? `Usuario creado: ${email}` : `Invitación enviada a ${email}`);
  }
  await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user!.id, role: 'service_role' })}, true)`;
    await tx`insert into public.platform_admins (user_id) values (${user!.id}) on conflict do nothing`;
  });
  console.warn(`Superadministrador listo: ${email} (${user.id})`);
} finally {
  await sql.end();
}
