import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/lib/db';
import { createTokenVerifier } from '../../src/lib/auth';
import type { AuthAdmin } from '../../src/lib/supabase-admin';
import { AppError } from '@rep/shared';
import { JWT_SECRET, TEST_DB_URL, db, seedWorld, token, type Db, type World } from '../fixtures';
import { RecordingQueue } from '../../src/domain/queue';

let app: FastifyInstance;
let seed: Db;
let w: World;
const invited: string[] = [];

beforeAll(async () => {
  seed = db();
  w = await seedWorld(seed);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    LOG_LEVEL: 'silent',
    ENFORCE_ADMIN_MFA: 'true',
  } as NodeJS.ProcessEnv);
  // Doble de prueba explícito: no se envían emails reales en tests.
  const authAdmin: AuthAdmin = {
    async inviteUser(email) {
      invited.push(email);
      throw new AppError('NOT_SUPPORTED', 'Invitaciones deshabilitadas en tests');
    },
  };
  app = await buildApp({
    config,
    sql: createDb(config),
    verifyToken: createTokenVerifier(config),
    authAdmin,
    queue: new RecordingQueue(),
    ai: null,
  });
});

afterAll(async () => {
  await app.close();
  await app.deps.sql.end();
  await seed.end();
});

const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId?: string,
  body?: unknown,
  aal: 'aal1' | 'aal2' = 'aal1',
) => {
  const headers: Record<string, string> = {};
  if (userId) headers.authorization = `Bearer ${await token(userId, { aal })}`;
  const res = await app.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

describe('API · autenticación', () => {
  it('rechaza peticiones sin token', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(401);
  });

  it('rechaza tokens manipulados o caducados', async () => {
    const t = await token(w.users.adminA);
    const forged = t.slice(0, -4) + 'AAAA';
    const r1 = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(r1.statusCode).toBe(401);
    const expired = await token(w.users.adminA, { expiresIn: '-1m' });
    const r2 = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(r2.statusCode).toBe(401);
    // alg=none
    const [, payload] = t.split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    const r3 = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${none}` },
    });
    expect(r3.statusCode).toBe(401);
  });

  it('devuelve el perfil y las membresías con permisos', async () => {
    const r = await call('GET', '/v1/me', w.users.managerA);
    expect(r.status).toBe(200);
    expect(r.body.isPlatformAdmin).toBe(false);
    expect(r.body.memberships).toHaveLength(1);
    expect(r.body.memberships[0].roleKey).toBe('account_manager');
    expect(r.body.memberships[0].permissions).toContain('clients.read');
    expect(r.body.memberships[0].permissions).not.toContain('responses.approve');
  });

  it('no expone cabeceras de autorización en errores', async () => {
    const r = await call('GET', `/v1/clients/${w.clientB1}`, w.users.adminA);
    expect(JSON.stringify(r.body)).not.toMatch(/Bearer|eyJ/);
  });
});

describe('API · aislamiento multi-tenant', () => {
  it('no permite listar clientes de otra organización', async () => {
    const r = await call('GET', `/v1/organizations/${w.orgA}/clients`, w.users.adminB);
    expect(r.status).toBe(403);
  });

  it('responde 404 (no 403) para clientes ajenos', async () => {
    expect((await call('GET', `/v1/clients/${w.clientA1}`, w.users.adminB)).status).toBe(404);
    expect(
      (await call('PATCH', `/v1/clients/${w.clientA1}`, w.users.adminB, { name: 'x' })).status,
    ).toBe(404);
  });

  it('el gestor solo lista sus clientes asignados', async () => {
    const r = await call('GET', `/v1/organizations/${w.orgA}/clients`, w.users.managerA);
    expect(r.status).toBe(200);
    expect(r.body.items.map((c: { id: string }) => c.id)).toEqual([w.clientA1]);
    expect(r.body.total).toBe(1);
  });

  it('el gestor no puede crear clientes', async () => {
    expect(
      (
        await call('POST', `/v1/organizations/${w.orgA}/clients`, w.users.managerA, {
          name: 'Nuevo',
        })
      ).status,
    ).toBe(403);
  });

  it('ignora intentos de inyectar organization_id en el cuerpo', async () => {
    const r = await call('POST', `/v1/organizations/${w.orgA}/clients`, w.users.adminA, {
      name: 'X',
      organizationId: w.orgB,
    });
    expect(r.status).toBe(400);
  });
});

describe('API · clientes y ubicaciones', () => {
  let clientId: string;

  it('crea un cliente validando entradas', async () => {
    const bad = await call('POST', `/v1/organizations/${w.orgA}/clients`, w.users.adminA, {
      name: '',
      website: 'javascript:x',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');

    const r = await call('POST', `/v1/organizations/${w.orgA}/clients`, w.users.adminA, {
      name: 'Café Delta',
      sector: 'Hostelería',
      website: 'https://cafedelta.example',
      timezone: 'Atlantic/Canary',
      accountManagerId: w.users.managerA,
    });
    expect(r.status).toBe(201);
    expect(r.body.organizationId).toBe(w.orgA);
    expect(r.body.timezone).toBe('Atlantic/Canary');
    clientId = r.body.id;
  });

  it('rechaza responsables de cuenta de otra organización', async () => {
    const r = await call('PATCH', `/v1/clients/${clientId}`, w.users.adminA, {
      accountManagerId: w.users.adminB,
    });
    expect(r.status).toBe(400);
  });

  it('busca, pagina y ordena', async () => {
    const r = await call(
      'GET',
      `/v1/organizations/${w.orgA}/clients?q=delta&pageSize=1`,
      w.users.adminA,
    );
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].name).toBe('Café Delta');
    const wild = await call('GET', `/v1/organizations/${w.orgA}/clients?q=%25`, w.users.adminA);
    expect(wild.body.items).toHaveLength(0); // el comodín se escapa
  });

  it('gestiona ubicaciones con una única principal', async () => {
    const a = await call('POST', `/v1/clients/${clientId}/locations`, w.users.adminA, {
      name: 'Centro',
      isPrimary: true,
      countryCode: 'es',
    });
    expect(a.status).toBe(201);
    expect(a.body.countryCode).toBe('ES');
    const b = await call('POST', `/v1/clients/${clientId}/locations`, w.users.adminA, {
      name: 'Puerto',
      isPrimary: true,
    });
    expect(b.status).toBe(201);
    const detail = await call('GET', `/v1/clients/${clientId}`, w.users.adminA);
    const primaries = detail.body.locations.filter((l: { isPrimary: boolean }) => l.isPrimary);
    expect(primaries.map((l: { name: string }) => l.name)).toEqual(['Puerto']);
  });

  it('el gestor no puede editar clientes no asignados', async () => {
    expect(
      (await call('PATCH', `/v1/clients/${w.clientA2}`, w.users.managerA, { sector: 'x' })).status,
    ).toBe(404);
    const ok = await call('PATCH', `/v1/clients/${w.clientA1}`, w.users.managerA, {
      sector: 'Restauración',
    });
    expect(ok.status).toBe(200);
  });

  it('archivar registra la fecha y lo oculta del listado por defecto', async () => {
    const r = await call('PATCH', `/v1/clients/${clientId}`, w.users.adminA, {
      status: 'archived',
    });
    expect(r.body.archivedAt).not.toBeNull();
    const list = await call('GET', `/v1/organizations/${w.orgA}/clients`, w.users.adminA);
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(clientId);
  });

  it('el resumen usa datos reales y declara módulos no disponibles', async () => {
    const r = await call('GET', `/v1/organizations/${w.orgA}/overview`, w.users.adminA);
    expect(r.status).toBe(200);
    expect(r.body.counts.clientsTotal).toBe(2);
    expect(r.body.modules.inbox.status).toBe('available');
    expect(r.body.modules.alerts.status).toBe('not_available');
  });
});

describe('API · operaciones sensibles y MFA', () => {
  it('exige MFA (aal2) para gestionar miembros', async () => {
    const body = { userId: w.users.managerA };
    const r1 = await call(
      'POST',
      `/v1/clients/${w.clientA2}/members`,
      w.users.adminA,
      body,
      'aal1',
    );
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('MFA_REQUIRED');
    const r2 = await call(
      'POST',
      `/v1/clients/${w.clientA2}/members`,
      w.users.adminA,
      body,
      'aal2',
    );
    expect(r2.status).toBe(201);
  });

  it('solo superadministradores crean organizaciones', async () => {
    const body = { name: 'Nueva', slug: 'nueva-agencia', ownerEmail: 'owner@test.local' };
    expect((await call('POST', '/v1/organizations', w.users.adminA, body, 'aal2')).status).toBe(
      403,
    );
    expect(
      (await call('POST', '/v1/organizations', w.users.superadmin, body, 'aal1')).body.error.code,
    ).toBe('MFA_REQUIRED');
  });

  it('no simula invitaciones si el proveedor de email no está configurado', async () => {
    const body = { name: 'Nueva', slug: 'nueva-agencia', ownerEmail: 'owner@test.local' };
    const r = await call('POST', '/v1/organizations', w.users.superadmin, body, 'aal2');
    expect(r.status).toBe(501);
    expect(invited).toContain('owner@test.local');
    const [o] = await seed`select id from public.organizations where slug = 'nueva-agencia'`;
    expect(o).toBeUndefined();
  });

  it('crea una organización con un propietario existente y lo audita', async () => {
    const [u] = await seed<
      { id: string; email: string }[]
    >`select id, email from auth.users where id = ${w.users.outsider}`;
    const r = await call(
      'POST',
      '/v1/organizations',
      w.users.superadmin,
      { name: 'Agencia Épsilon', slug: 'epsilon', ownerEmail: u!.email },
      'aal2',
    );
    expect(r.status).toBe(201);
    expect(r.body.ownerInvited).toBe(false);
    const me = await call('GET', '/v1/me', w.users.outsider);
    expect(me.body.memberships[0].roleKey).toBe('org_admin');
    const [log] =
      await seed`select actor_user_id from public.audit_logs where action = 'organizations.insert' and entity_id = ${r.body.organization.id}`;
    expect(log!.actorUserId).toBe(w.users.superadmin);
  });

  it('el gestor no puede leer la auditoría', async () => {
    expect((await call('GET', `/v1/organizations/${w.orgA}/audit`, w.users.managerA)).status).toBe(
      403,
    );
    const ok = await call('GET', `/v1/organizations/${w.orgA}/audit`, w.users.adminA);
    expect(ok.status).toBe(200);
    expect(ok.body.length).toBeGreaterThan(0);
  });
});

describe('API · invitaciones', () => {
  it('activa la membresía invitada al iniciar sesión, pero no reactiva suspendidos', async () => {
    const [u] = await seed<
      { id: string }[]
    >`insert into auth.users (email) values ('invitado@test.local') returning id`;
    const [role] = await seed<
      { id: string }[]
    >`select id from public.roles where key = 'account_manager'`;
    await seed`insert into public.organization_members (organization_id, user_id, role_id, status) values (${w.orgA}, ${u!.id}, ${role!.id}, 'invited')`;
    const before = await call('GET', '/v1/me', u!.id);
    expect(before.body.memberships).toHaveLength(1);
    await seed`update public.organization_members set status = 'suspended' where user_id = ${u!.id}`;
    const after = await call('GET', '/v1/me', u!.id);
    expect(after.body.memberships).toHaveLength(0);
  });
});
