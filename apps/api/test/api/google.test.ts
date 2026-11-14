/**
 * Fase 4 · Google Business Profile contra un servidor FALSO de Google
 * (`@rep/connectors/testing`). No hay llamadas reales: se comprueba el flujo
 * OAuth, el sellado de tokens, la selección de ubicaciones, la sincronización,
 * la publicación sin duplicados, el refresco y la revocación.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, responseHash } from '@rep/shared';
import { FakeGoogleApi } from '@rep/connectors/testing';
import { buildApp } from '../../src/app';
import { createIntegrations } from '../../src/domain/credentials';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/lib/db';
import { createTokenVerifier } from '../../src/lib/auth';
import { RecordingQueue, QUEUES, type QueueName } from '../../src/domain/queue';
import { createConnectorRegistry } from '../../src/domain/connectors';
import { runSync, type JobDeps } from '../../src/domain/sync';
import { runPublish } from '../../src/domain/publish';
import { loadCredential, updateCredential } from '../../src/domain/credentials';
import { sweepCredentials } from '../../src/domain/connection-lifecycle';
import {
  JWT_SECRET,
  TEST_DB_URL,
  asUser,
  db,
  expectSqlError,
  seedWorld,
  token,
  type Db,
  type World,
} from '../fixtures';

const KEY = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
const LOC_OK = 'accounts/111/locations/222';
const LOC_UNVERIFIED = 'accounts/111/locations/333';

let app: FastifyInstance;
let bare: FastifyInstance;
let seed: Db;
let w: World;
let deps: JobDeps;
const queue = new RecordingQueue();
const google = new FakeGoogleApi('test-google-client-id', 'test-google-client-secret');

const env = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    LOG_LEVEL: 'silent',
    JOBS_ENABLED: 'false',
    APP_URL: 'http://app.test',
    API_PUBLIC_URL: 'http://api.test',
    ...extra,
  } as NodeJS.ProcessEnv);

const authAdmin = {
  inviteUser: async () => {
    throw new AppError('NOT_SUPPORTED', 'no');
  },
};

beforeAll(async () => {
  seed = db();
  w = await seedWorld(seed);
  const config = env({
    CREDENTIALS_ENCRYPTION_KEYS: KEY,
    GOOGLE_OAUTH_CLIENT_ID: google.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
  });
  const sql = createDb(config);
  const integrations = createIntegrations(config, { fetch: google.fetch });
  app = await buildApp({
    config,
    sql,
    verifyToken: createTokenVerifier(config),
    authAdmin,
    queue,
    integrations,
    ai: null,
  });
  deps = {
    sql,
    registry: createConnectorRegistry(sql, integrations),
    queue,
    authorRefPepper: 'test-pepper-test-pepper',
  };
  const bareConfig = env();
  bare = await buildApp({
    config: bareConfig,
    sql,
    verifyToken: createTokenVerifier(bareConfig),
    authAdmin,
    queue: new RecordingQueue(),
    integrations: createIntegrations(bareConfig),
    ai: null,
  });
});

afterAll(async () => {
  await app.close();
  await bare.close();
  await app.deps.sql.end();
  await seed.end();
});

const call = async (
  method: 'GET' | 'POST',
  url: string,
  userId?: string,
  body?: unknown,
  target: FastifyInstance = app,
) => {
  const headers: Record<string, string> = {};
  if (userId) headers.authorization = `Bearer ${await token(userId)}`;
  const res = await target.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    location: res.headers.location as string | undefined,
    body: res.body && res.headers['content-type']?.includes('json') ? res.json() : null,
  };
};

const drain = async (q: QueueName, fn: (id: string) => Promise<unknown>) => {
  const out = [];
  for (const m of queue.take(q)) out.push(await fn(m.id));
  return out;
};

async function authorize(user = w.users.adminA, clientId = w.clientA1) {
  const start = await call('POST', `/v1/clients/${clientId}/connections/google/start`, user);
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const { code, state } = google.authorize(start.body.authorizationUrl);
  const cb = await call('GET', `/v1/oauth/google/callback?${new URLSearchParams({ code, state })}`);
  return { start, cb, state, code };
}

let credentialId: string;
let accountOk: string;
let accountUnverified: string;

describe('Fase 4 · Google no configurado', () => {
  it('no aparenta estar disponible ni deja empezar la conexión', async () => {
    const st = await call('GET', '/v1/integrations', w.users.adminA, undefined, bare);
    expect(st.body.google).toMatchObject({ configured: false });
    expect(st.body.google.missing).toContain('GOOGLE_OAUTH_CLIENT_ID');
    const r = await call(
      'POST',
      `/v1/clients/${w.clientA1}/connections/google/start`,
      w.users.adminA,
      undefined,
      bare,
    );
    expect(r.status).toBe(409);
    const cb = await call(
      'GET',
      '/v1/oauth/google/callback?state=x&code=y',
      undefined,
      undefined,
      bare,
    );
    expect(cb.location).toBe('http://app.test/fuentes?google_error=not_configured');
  });

  it('exige clave de cifrado si hay cliente OAuth', () => {
    expect(() =>
      env({ GOOGLE_OAUTH_CLIENT_ID: 'x'.repeat(12), GOOGLE_OAUTH_CLIENT_SECRET: 'y'.repeat(12) }),
    ).toThrow();
  });
});

describe('Fase 4 · OAuth de Google', () => {
  it('informa del redirect URI que hay que registrar en Google Cloud', async () => {
    const st = await call('GET', '/v1/integrations', w.users.adminA);
    expect(st.body.google).toMatchObject({
      configured: true,
      redirectUri: 'http://api.test/v1/oauth/google/callback',
      missing: [],
    });
  });

  it('solo quien gestiona fuentes del cliente puede iniciar la conexión', async () => {
    expect(
      (await call('POST', `/v1/clients/${w.clientA1}/connections/google/start`, w.users.adminB))
        .status,
    ).toBe(404);
    expect((await call('POST', `/v1/clients/${w.clientA1}/connections/google/start`)).status).toBe(
      401,
    );
  });

  it('guarda solo el hash del state y el verificador sellado; el state es de un solo uso', async () => {
    const { start, cb, state, code } = await authorize();
    const url = new URL(start.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('http://api.test/v1/oauth/google/callback');
    const hash = createHash('sha256').update(state).digest('hex');
    const [row] = await seed<{ codeVerifierSealed: string; consumedAt: Date | null }[]>`
      select code_verifier_sealed, consumed_at from private.oauth_states where state_hash = ${hash}`;
    expect(row!.codeVerifierSealed.startsWith('v1.k1.')).toBe(true);
    expect(row!.consumedAt).not.toBeNull();
    expect(await seed`select 1 from private.oauth_states where state_hash = ${state}`).toHaveLength(
      0,
    );

    expect(cb.status).toBe(303);
    const back = new URL(cb.location!);
    expect(back.origin + back.pathname).toBe('http://app.test/fuentes');
    credentialId = back.searchParams.get('google')!;
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
    expect(back.searchParams.get('client')).toBe(w.clientA1);

    const replay = await call(
      'GET',
      `/v1/oauth/google/callback?${new URLSearchParams({ code, state })}`,
    );
    expect(replay.location).toContain('google_error=invalid_state');
    const forged = await call('GET', '/v1/oauth/google/callback?state=inventado&code=x');
    expect(forged.location).toContain('google_error=invalid_state');
  });

  it('si el usuario cancela en Google no se guarda nada', async () => {
    const start = await call(
      'POST',
      `/v1/clients/${w.clientA1}/connections/google/start`,
      w.users.adminA,
    );
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    const before = await seed`select id from private.provider_credentials`;
    const cb = await call(
      'GET',
      `/v1/oauth/google/callback?${new URLSearchParams({ state, error: 'access_denied' })}`,
    );
    expect(cb.location).toContain('google_error=access_denied');
    expect(await seed`select id from private.provider_credentials`).toHaveLength(before.length);
  });

  it('rechaza una autorización sin el permiso business.manage y la revoca', async () => {
    const start = await call(
      'POST',
      `/v1/clients/${w.clientA1}/connections/google/start`,
      w.users.adminA,
    );
    const { code, state } = google.authorize(start.body.authorizationUrl, 'openid email');
    const revokedBefore = google.revoked.length;
    const cb = await call(
      'GET',
      `/v1/oauth/google/callback?${new URLSearchParams({ code, state })}`,
    );
    expect(cb.location).toContain('google_error=missing_scope');
    expect(google.revoked.length).toBe(revokedBefore + 1);
  });

  it('los tokens están sellados y fuera del alcance de usuarios y del cliente web', async () => {
    const [c] = await seed<{ sealed: string; keyId: string }[]>`
      select sealed, key_id from private.provider_credentials where id = ${credentialId}`;
    expect(c!.keyId).toBe('k1');
    expect(c!.sealed).not.toMatch(/ya29|1\/\//);
    // Copiar el valor a otra fila no permite abrirlo (AAD = id).
    expect(() => app.deps.integrations.box!.open(c!.sealed, 'otra-fila')).toThrow();
    await expectSqlError(
      asUser(seed, w.users.adminA, (tx) => tx`select sealed from private.provider_credentials`),
      '42501',
    );
    await expectSqlError(
      asUser(seed, w.users.adminA, (tx) => tx`select * from private.oauth_states`),
      '42501',
    );
    const logs = await seed<
      { t: string }[]
    >`select coalesce(changes::text, '') || metadata::text as t from public.audit_logs`;
    expect(logs.some((l) => /ya29|1\/\/fake/.test(l.t))).toBe(false);
  });
});

describe('Fase 4 · selección de ubicaciones', () => {
  it('lista ubicaciones con su aptitud para responder; solo para quien autorizó', async () => {
    const r = await call('GET', `/v1/google/credentials/${credentialId}/locations`, w.users.adminA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const locs = r.body.accounts[0].locations;
    expect(
      locs.map((l: { externalId: string; canReply: boolean }) => [l.externalId, l.canReply]),
    ).toEqual([
      [LOC_OK, true],
      [LOC_UNVERIFIED, false],
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/ya29|1\/\//);
    expect(
      (await call('GET', `/v1/google/credentials/${credentialId}/locations`, w.users.managerA))
        .status,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/google/credentials/${credentialId}/locations`, w.users.adminB))
        .status,
    ).toBe(404);
  });

  it('no acepta ubicaciones que no pertenecen a la autorización', async () => {
    const r = await call('POST', `/v1/google/credentials/${credentialId}/connect`, w.users.adminA, {
      items: [{ externalLocationId: 'accounts/999/locations/1', locationId: null }],
    });
    expect(r.status).toBe(400);
  });

  it('conecta las ubicaciones elegidas y lanza la primera sincronización', async () => {
    const loc = google.location(LOC_OK)!;
    loc.reviews.push(
      {
        reviewId: 'g1',
        displayName: 'Persona Ficticia',
        starRating: 'FIVE',
        comment: 'Muy buena atención',
        createTime: '2026-11-10T10:00:00Z',
      },
      {
        reviewId: 'g2',
        isAnonymous: true,
        starRating: 'TWO',
        comment: 'La comida llegó fría',
        createTime: '2026-11-11T10:00:00Z',
      },
      {
        reviewId: 'g3',
        displayName: 'Otra Persona',
        starRating: 'FOUR',
        comment: 'Bien',
        createTime: '2026-11-09T10:00:00Z',
        reply: { comment: 'Gracias por venir', updateTime: '2026-11-09T12:00:00Z' },
      },
    );
    google.location(LOC_UNVERIFIED)!.reviews.push({
      reviewId: 'u1',
      displayName: 'Cliente Puerto',
      starRating: 'THREE',
      comment: 'Normal',
      createTime: '2026-11-08T10:00:00Z',
    });
    const r = await call('POST', `/v1/google/credentials/${credentialId}/connect`, w.users.adminA, {
      items: [
        { externalLocationId: LOC_OK, locationId: null },
        { externalLocationId: LOC_UNVERIFIED, locationId: null },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    [accountOk, accountUnverified] = r.body.items.map((i: { id: string }) => i.id);
    const res = await drain(QUEUES.sync, (id) => runSync(deps, id));
    expect(res.map((x) => (x as { status: string }).status)).toEqual(['succeeded', 'succeeded']);

    const rows = await seed<
      {
        externalId: string;
        authorDisplayName: string | null;
        rating: string;
        isSimulated: boolean;
        existingReplyContent: string | null;
      }[]
    >`
      select external_id, author_display_name, rating, is_simulated, existing_reply_content
        from public.external_interactions where connected_account_id = ${accountOk} order by external_id`;
    expect(rows.map((x) => x.externalId)).toEqual(['g1', 'g2', 'g3']);
    expect(rows[1]!.authorDisplayName).toBeNull();
    expect(rows.every((x) => !x.isSimulated)).toBe(true);
    expect(rows[2]!.existingReplyContent).toBe('Gracias por venir');

    const list = await call(
      'GET',
      `/v1/organizations/${w.orgA}/connections?clientId=${w.clientA1}`,
      w.users.adminA,
    );
    const mine = list.body.items.find((a: { id: string }) => a.id === accountOk);
    expect(mine).toMatchObject({
      provider: 'google_business_profile',
      status: 'connected',
      isSimulated: false,
    });
    expect(mine.capabilities).toContain('publish_reply');
    expect(mine).not.toHaveProperty('credentialId');
    const unv = list.body.items.find((a: { id: string }) => a.id === accountUnverified);
    expect(unv.capabilities).not.toContain('publish_reply');
    await expectSqlError(
      asUser(seed, w.users.adminA, (tx) => tx`select credential_id from public.connected_accounts`),
      '42501',
    );
  });

  it('una fuente real no puede quedar «conectada» sin credencial', async () => {
    await expectSqlError(
      seed`update public.connected_accounts set credential_id = null where id = ${accountOk}`,
      '23514',
    );
  });
});

async function approve(interactionId: string, text: string) {
  expect(
    (
      await call('POST', `/v1/interactions/${interactionId}/drafts`, w.users.managerA, {
        content: text,
      })
    ).status,
  ).toBe(201);
  expect(
    (await call('POST', `/v1/interactions/${interactionId}/request-approval`, w.users.managerA))
      .status,
  ).toBe(200);
  const r = await call('POST', `/v1/interactions/${interactionId}/decision`, w.users.approverA, {
    decision: 'approve',
    contentHash: await responseHash(text),
    specialistReviewed: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const idOf = async (externalId: string) =>
  (
    await seed<
      { id: string }[]
    >`select id from public.external_interactions where external_id = ${externalId} and provider = 'google_business_profile'`
  )[0]!.id;
const puts = (reviewId: string) =>
  google.calls.filter((c) => c.method === 'PUT' && c.url.endsWith(`/reviews/${reviewId}/reply`))
    .length;

describe('Fase 4 · publicación en Google', () => {
  it('publica la respuesta aprobada una sola vez y verifica el texto visible', async () => {
    const id = await idOf('g1');
    await approve(id, 'Muchas gracias por tu reseña.');
    const out = await drain(QUEUES.publish, (j) => runPublish(deps, j));
    expect(out[0]).toMatchObject({ status: 'published' });
    expect(puts('g1')).toBe(1);
    expect(google.location(LOC_OK)!.reviews.find((r) => r.reviewId === 'g1')!.reply!.comment).toBe(
      'Muchas gracias por tu reseña.',
    );
    const [i] = await seed<
      { state: string }[]
    >`select state from public.external_interactions where id = ${id}`;
    expect(i!.state).toBe('published');
    const [rc] = await seed<{ providerState: string }[]>`
      select r.provider_state from public.publication_receipts r join public.publication_jobs j on j.id = r.job_id
       where j.interaction_id = ${id}`;
    expect(rc!.providerState).toBe('visible');
  });

  it('si la conexión se corta tras escribir, consulta Google y no vuelve a publicar', async () => {
    const id = await idOf('g2');
    await approve(id, 'Sentimos lo ocurrido con tu pedido.');
    google.dropAfterWrite = true;
    const out = await drain(QUEUES.publish, (j) => runPublish(deps, j));
    expect(out[0]).toMatchObject({ status: 'published', viaStatusCheck: true });
    expect(puts('g2')).toBe(1);
  });

  it('en una ficha no verificada no llama a Google y deja un error claro', async () => {
    const id = await idOf('u1');
    await approve(id, 'Gracias por tu opinión.');
    const out = await drain(QUEUES.publish, (j) => runPublish(deps, j));
    expect(out[0]).toMatchObject({ status: 'failed' });
    expect(puts('u1')).toBe(0);
    const [j] = await seed<{ lastErrorKind: string; lastErrorMessage: string }[]>`
      select last_error_kind, last_error_message from public.publication_jobs where interaction_id = ${id}`;
    expect(j!.lastErrorKind).toBe('insufficient_permissions');
    expect(j!.lastErrorMessage).toContain('no está verificada');
  });
});

describe('Fase 4 · refresco, revocación y desconexión', () => {
  const box = () => app.deps.integrations.box!;
  const expireStored = async () => {
    await seed.begin(async (tx) => {
      const c = await loadCredential(tx, box(), credentialId);
      await updateCredential(tx, box(), credentialId, {
        ...c!.credentials,
        expiresAt: new Date(0),
      });
    });
  };
  const manualSync = async (accountId: string) => {
    const r = await call('POST', `/v1/connections/${accountId}/sync`, w.users.adminA);
    expect([200, 202]).toContain(r.status);
    return drain(QUEUES.sync, (id) => runSync(deps, id));
  };

  it('refresca el token caducado antes de sincronizar y lo vuelve a sellar', async () => {
    await expireStored();
    const before = google.calls.filter((c) => c.url.includes('oauth2.googleapis.com/token')).length;
    const [r] = await manualSync(accountOk);
    expect(r).toMatchObject({ status: 'succeeded' });
    expect(google.calls.filter((c) => c.url.includes('oauth2.googleapis.com/token')).length).toBe(
      before + 1,
    );
    const [c] = await seed<{ refreshedAt: Date | null }[]>`
      select refreshed_at from private.provider_credentials where id = ${credentialId}`;
    expect(c!.refreshedAt).not.toBeNull();
  });

  it('una autorización revocada en Google no aparenta funcionar', async () => {
    const c = await seed.begin((tx) => loadCredential(tx, box(), credentialId));
    google.revoked.push(c!.credentials.refreshToken!);
    await expireStored();
    const [r] = await manualSync(accountOk);
    expect(r).toMatchObject({ status: 'failed', error: { kind: 'credentials_expired' } });
    const [a] = await seed<
      { status: string }[]
    >`select status from public.connected_accounts where id = ${accountOk}`;
    expect(a!.status).toBe('credentials_expired');
    // Los demás conectores siguen funcionando (fallo aislado).
    google.revoked.pop();
  });

  it('al desconectar la última fuente se revoca en Google y se borra la credencial', async () => {
    const c = await seed.begin((tx) => loadCredential(tx, box(), credentialId));
    const d1 = await call(
      'POST',
      `/v1/connections/${accountUnverified}/disconnect`,
      w.users.adminA,
    );
    expect(d1.body).toMatchObject({ ok: true, credentialReleased: false });
    const d2 = await call('POST', `/v1/connections/${accountOk}/disconnect`, w.users.adminA);
    expect(d2.body).toMatchObject({ ok: true, credentialReleased: true, revokedAtProvider: true });
    expect(google.revoked).toContain(c!.credentials.refreshToken);
    expect(
      await seed`select 1 from private.provider_credentials where id = ${credentialId}`,
    ).toHaveLength(0);
  });

  it('el barrido revoca autorizaciones abandonadas sin ubicaciones elegidas', async () => {
    const { cb } = await authorize();
    const abandoned = new URL(cb.location!).searchParams.get('google')!;
    expect(await sweepCredentials(app.deps.sql, app.deps.integrations, 60)).toBe(0);
    await seed`update private.provider_credentials set created_at = now() - interval '2 hours' where id = ${abandoned}`;
    expect(await sweepCredentials(app.deps.sql, app.deps.integrations, 60)).toBe(1);
    expect(
      await seed`select 1 from private.provider_credentials where id = ${abandoned}`,
    ).toHaveLength(0);
  });
});
