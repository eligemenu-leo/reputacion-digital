import postgres from 'postgres';
import { SignJWT } from 'jose';

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:54329/postgres';
export const TEST_DB_URL = `${ADMIN_URL.replace(/\/[^/]*$/, '')}/${process.env.TEST_DATABASE_NAME ?? 'reputacion_test'}`;
export const JWT_SECRET = 'test-secret-test-secret-test-secret-123456';

export const db = () =>
  postgres(TEST_DB_URL, {
    max: 4,
    onnotice: () => {},
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel }, undefined: null },
  });

export type Db = ReturnType<typeof db>;

export interface World {
  users: Record<'superadmin' | 'adminA' | 'managerA' | 'approverA' | 'adminB' | 'outsider', string>;
  orgA: string;
  orgB: string;
  clientA1: string;
  clientA2: string;
  clientB1: string;
  customRoleB: string;
}

/** Crea dos organizaciones con usuarios y clientes (como superusuario, sin RLS). */
export async function seedWorld(sql: Db): Promise<World> {
  const u = async (email: string) =>
    (await sql<{ id: string }[]>`insert into auth.users (email) values (${email}) returning id`)[0]!
      .id;
  const tag = Math.random().toString(36).slice(2, 8);
  const users = {
    superadmin: await u(`super-${tag}@test.local`),
    adminA: await u(`admin-a-${tag}@test.local`),
    managerA: await u(`manager-a-${tag}@test.local`),
    approverA: await u(`approver-a-${tag}@test.local`),
    adminB: await u(`admin-b-${tag}@test.local`),
    outsider: await u(`outsider-${tag}@test.local`),
  };
  await sql`insert into public.platform_admins (user_id) values (${users.superadmin})`;
  const role = async (key: string) =>
    (await sql<{ id: string }[]>`select id from public.roles where key = ${key} and is_system`)[0]!
      .id;
  const [orgAdmin, manager, approver] = [
    await role('org_admin'),
    await role('account_manager'),
    await role('approver'),
  ];

  const org = async (slug: string) =>
    (
      await sql<
        { id: string }[]
      >`insert into public.organizations (name, slug) values (${'Org ' + slug}, ${slug + '-' + tag}) returning id`
    )[0]!.id;
  const orgA = await org('a');
  const orgB = await org('b');

  await sql`insert into public.organization_members (organization_id, user_id, role_id, all_clients_access) values
    (${orgA}, ${users.adminA}, ${orgAdmin}, true),
    (${orgA}, ${users.managerA}, ${manager}, false),
    (${orgA}, ${users.approverA}, ${manager}, false),
    (${orgB}, ${users.adminB}, ${orgAdmin}, true)`;

  const client = async (o: string, name: string) =>
    (
      await sql<
        { id: string }[]
      >`insert into public.clients (organization_id, name, status) values (${o}, ${name}, 'active') returning id`
    )[0]!.id;
  const clientA1 = await client(orgA, 'Restaurante Alfa');
  const clientA2 = await client(orgA, 'Hotel Beta');
  const clientB1 = await client(orgB, 'Clínica Gamma');

  await sql`insert into public.client_locations (organization_id, client_id, name, is_primary) values
    (${orgA}, ${clientA1}, 'Alfa Centro', true), (${orgA}, ${clientA2}, 'Beta Playa', true), (${orgB}, ${clientB1}, 'Gamma Norte', true)`;

  await sql`insert into public.client_members (organization_id, client_id, user_id, role_id) values
    (${orgA}, ${clientA1}, ${users.managerA}, null),
    (${orgA}, ${clientA1}, ${users.approverA}, ${approver})`;

  const customRoleB = (
    await sql<{ id: string }[]>`
    insert into public.roles (organization_id, key, name) values (${orgB}, 'custom_b', 'Rol B') returning id`
  )[0]!.id;

  return { users, orgA, orgB, clientA1, clientA2, clientB1, customRoleB };
}

/** Ejecuta fn como usuario autenticado con RLS (igual que la API). */
export async function asUser<T>(
  sql: Db,
  userId: string | null,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: 'authenticated' })}, true)`;
      await tx.unsafe('set local role authenticated');
    } else {
      await tx.unsafe('set local role anon');
    }
    return fn(tx);
  }) as Promise<T>;
}

export async function token(
  userId: string,
  opts: { aal?: 'aal1' | 'aal2'; email?: string; expiresIn?: string } = {},
) {
  return new SignJWT({
    role: 'authenticated',
    aal: opts.aal ?? 'aal1',
    email: opts.email ?? 'x@test.local',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/** Espera que la promesa falle con un código SQLSTATE concreto. */
export async function expectSqlError(p: Promise<unknown>, codes: string | string[]) {
  const list = Array.isArray(codes) ? codes : [codes];
  try {
    await p;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && list.includes(code)) return;
    throw new Error(
      `Se esperaba SQLSTATE ${list.join('/')} y se obtuvo ${code}: ${(e as Error).message}`,
    );
  }
  throw new Error(`Se esperaba SQLSTATE ${list.join('/')} pero la operación tuvo éxito`);
}
