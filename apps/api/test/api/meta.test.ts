/**
 * Fase 4 · Facebook e Instagram contra una Graph API FALSA de Meta
 * (`@rep/connectors/testing`). No hay llamadas reales: se comprueba el inicio
 * de sesión, el sellado de tokens, la elección de páginas, la sincronización,
 * la publicación sin duplicados, los webhooks firmados y la desconexión.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, responseHash } from '@rep/shared';
import { FakeMetaApi } from '@rep/connectors/testing';
import { buildApp } from '../../src/app';
import { createIntegrations, loadCredential } from '../../src/domain/credentials';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/lib/db';
import { createTokenVerifier } from '../../src/lib/auth';
import { RecordingQueue, QUEUES, type QueueName } from '../../src/domain/queue';
import { createConnectorRegistry } from '../../src/domain/connectors';
import { runSync, type JobDeps } from '../../src/domain/sync';
import { runPublish } from '../../src/domain/publish';
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

const KEY = `k1:${Buffer.alloc(32, 9).toString('base64')}`;
const VERIFY = 'verify-token-de-prueba-123';
const IG = '178414000001';

let app: FastifyInstance;
let bare: FastifyInstance;
let seed: Db;
let w: World;
let deps: JobDeps;
const queue = new RecordingQueue();
const meta = new FakeMetaApi();

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
    META_APP_ID: meta.appId,
    META_APP_SECRET: meta.appSecret,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY,
  });
  const sql = createDb(config);
  const integrations = createIntegrations(config, { fetch: meta.fetch });
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
    text: res.body,
    body: res.body && res.headers['content-type']?.includes('json') ? res.json() : null,
  };
};

const hook = (body: unknown, secret = meta.appSecret) => {
  const { raw, sig } = meta.webhook(body, secret);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/meta',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    payload: raw,
  });
};

const drain = async (q: QueueName, fn: (id: string) => Promise<unknown>) => {
  const out = [];
  for (const m of queue.take(q)) out.push(await fn(m.id));
  return out;
};

async function authorize(scopes?: string[], user = w.users.adminA) {
  const start = await call('POST', `/v1/clients/${w.clientA1}/connections/meta/start`, user);
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const { code, state } = meta.authorize(start.body.authorizationUrl, scopes);
  const cb = await call('GET', `/v1/oauth/meta/callback?${new URLSearchParams({ code, state })}`);
  return { start, cb, state, code };
}

let credentialId: string;
let fbAccount: string;
let igAccount: string;

describe('Fase 4 · Meta no configurado', () => {
  it('no aparenta estar disponible', async () => {
    const st = await call('GET', '/v1/integrations', w.users.adminA, undefined, bare);
    expect(st.body.meta).toMatchObject({ configured: false, webhooks: false });
    expect(st.body.meta.missing).toContain('META_APP_ID');
    const r = await call(
      'POST',
      `/v1/clients/${w.clientA1}/connections/meta/start`,
      w.users.adminA,
      undefined,
      bare,
    );
    expect(r.status).toBe(409);
    const cb = await call(
      'GET',
      '/v1/oauth/meta/callback?state=x&code=y',
      undefined,
      undefined,
      bare,
    );
    expect(cb.location).toBe('http://app.test/fuentes?meta_error=not_configured');
    const v = await bare.inject({
      method: 'GET',
      url: `/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
    });
    expect(v.statusCode).toBe(404);
  });

  it('exige app completa y clave de cifrado', () => {
    expect(() => env({ META_APP_ID: '1234567890' })).toThrow();
    expect(() => env({ META_APP_ID: '1234567890', META_APP_SECRET: 's'.repeat(20) })).toThrow();
  });
});

describe('Fase 4 · inicio de sesión con Meta', () => {
  it('informa de los datos que hay que registrar en la app de Meta', async () => {
    const st = await call('GET', '/v1/integrations', w.users.adminA);
    expect(st.body.meta).toMatchObject({
      configured: true,
      webhooks: true,
      redirectUri: 'http://api.test/v1/oauth/meta/callback',
      webhookUrl: 'http://api.test/v1/webhooks/meta',
      graphVersion: 'v26.0',
      missing: [],
    });
  });

  it('solo quien gestiona fuentes del cliente puede empezar', async () => {
    expect(
      (await call('POST', `/v1/clients/${w.clientA1}/connections/meta/start`, w.users.adminB))
        .status,
    ).toBe(404);
  });

  it('state de un solo uso; el token se sella y no se guarda ninguna página todavía', async () => {
    const { start, cb, state, code } = await authorize();
    const url = new URL(start.body.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('http://api.test/v1/oauth/meta/callback');
    const hash = createHash('sha256').update(state).digest('hex');
    const [row] = await seed<{ provider: string; codeVerifierSealed: string | null }[]>`
      select provider, code_verifier_sealed from private.oauth_states where state_hash = ${hash}`;
    expect(row).toMatchObject({ provider: 'meta', codeVerifierSealed: null });

    expect(cb.status).toBe(303);
    const back = new URL(cb.location!);
    credentialId = back.searchParams.get('meta')!;
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
    const [c] = await seed<{ sealed: string; providerUserRef: string; provider: string }[]>`
      select sealed, provider_user_ref, provider from private.provider_credentials where id = ${credentialId}`;
    expect(c!.provider).toBe('meta');
    expect(c!.sealed).not.toMatch(/EAA/);
    expect(c!.providerUserRef).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.providerUserRef).not.toContain(meta.user.id);
    const loaded = await seed.begin((tx) =>
      loadCredential(tx, app.deps.integrations.box!, credentialId),
    );
    expect(loaded!.pages).toEqual({});

    const replay = await call(
      'GET',
      `/v1/oauth/meta/callback?${new URLSearchParams({ code, state })}`,
    );
    expect(replay.location).toContain('meta_error=invalid_state');
  });

  it('si el usuario cancela, o no concede lo mínimo, no se guarda nada', async () => {
    const before = (await seed`select id from private.provider_credentials`).length;
    const start = await call(
      'POST',
      `/v1/clients/${w.clientA1}/connections/meta/start`,
      w.users.adminA,
    );
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    const cancel = await call(
      'GET',
      `/v1/oauth/meta/callback?${new URLSearchParams({ state, error: 'access_denied', error_reason: 'user_denied' })}`,
    );
    expect(cancel.location).toContain('meta_error=access_denied');
    const { cb } = await authorize(['public_profile']);
    expect(cb.location).toContain('meta_error=missing_scope');
    expect((await seed`select id from private.provider_credentials`).length).toBe(before);
  });

  it('nadie fuera del backend puede leer credenciales ni avisos', async () => {
    await expectSqlError(
      asUser(seed, w.users.adminA, (tx) => tx`select * from private.webhook_events`),
      '42501',
    );
    await expectSqlError(
      asUser(seed, w.users.adminA, (tx) => tx`select sealed from private.provider_credentials`),
      '42501',
    );
  });
});

describe('Fase 4 · elección de páginas', () => {
  it('lista páginas y cuentas de Instagram con lo que se puede hacer; solo para quien autorizó', async () => {
    const r = await call('GET', `/v1/meta/credentials/${credentialId}/assets`, w.users.adminA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = r.body.items.map(
      (a: { provider: string; externalId: string; canRead: boolean; canReply: boolean }) => [
        a.provider,
        a.externalId,
        a.canRead,
        a.canReply,
      ],
    );
    expect(items).toEqual([
      ['facebook_page', '101', true, true],
      ['instagram_business', IG, true, true],
      ['facebook_page', '102', false, false],
    ]);
    expect(r.body.missingScopes).toEqual([]);
    expect(r.text).not.toMatch(/EAA/);
    expect(
      (await call('GET', `/v1/meta/credentials/${credentialId}/assets`, w.users.managerA)).status,
    ).toBe(404);
  });

  it('rechaza páginas ajenas o que no se pueden leer', async () => {
    for (const externalId of ['999', '102']) {
      const r = await call('POST', `/v1/meta/credentials/${credentialId}/connect`, w.users.adminA, {
        items: [{ provider: 'facebook_page', externalId, locationId: null }],
      });
      expect(r.status).toBe(400);
    }
  });

  it('conecta Facebook e Instagram, suscribe la página y sincroniza', async () => {
    const post = meta.page('101')!.posts[0]!;
    const a = meta.addComment(post, { text: '¿Tenéis menú sin gluten?', fromName: 'Ana Ficticia' });
    meta.addComment(post, { text: 'Muy buen servicio', fromName: 'Luis Ficticio' });
    a.replies.push({
      id: `${a.id}_1`,
      text: 'Sí, pregúntanos en sala',
      createdAt: new Date().toISOString(),
      fromId: '101',
      fromName: 'Página',
      replies: [],
    });
    meta.addComment(meta.page('101')!.instagram!.media[0]!, {
      text: 'Qué buena pinta',
      fromName: 'cliente_ficticio',
    });
    const r = await call('POST', `/v1/meta/credentials/${credentialId}/connect`, w.users.adminA, {
      items: [
        { provider: 'facebook_page', externalId: '101', locationId: null },
        { provider: 'instagram_business', externalId: IG, locationId: null },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    [fbAccount, igAccount] = r.body.items.map((i: { id: string }) => i.id);
    expect(meta.page('101')!.subscribed).toBe(true);
    expect(meta.page('102')!.subscribed).toBe(false);

    // Solo se conserva el token de la página elegida.
    const loaded = await seed.begin((tx) =>
      loadCredential(tx, app.deps.integrations.box!, credentialId),
    );
    expect(Object.keys(loaded!.pages)).toEqual(['101']);

    const res = await drain(QUEUES.sync, (id) => runSync(deps, id));
    expect(res.map((x) => (x as { status: string }).status)).toEqual(['succeeded', 'succeeded']);
    const rows = await seed<
      {
        provider: string;
        kind: string;
        content: string;
        existingReplyContent: string | null;
        isSimulated: boolean;
      }[]
    >`
      select provider, kind, content, existing_reply_content, is_simulated from public.external_interactions
       where connected_account_id in (${fbAccount}, ${igAccount}) order by provider, content`;
    expect(rows.map((x) => [x.provider, x.content, x.existingReplyContent])).toEqual([
      ['facebook_page', 'Muy buen servicio', null],
      ['facebook_page', '¿Tenéis menú sin gluten?', 'Sí, pregúntanos en sala'],
      ['instagram_business', 'Qué buena pinta', null],
    ]);
    expect(rows.every((x) => x.kind === 'comment' && !x.isSimulated)).toBe(true);
    const list = await call(
      'GET',
      `/v1/organizations/${w.orgA}/connections?clientId=${w.clientA1}`,
      w.users.adminA,
    );
    const fb = list.body.items.find((x: { id: string }) => x.id === fbAccount);
    expect(fb.capabilities).toEqual(expect.arrayContaining(['publish_reply', 'webhooks']));
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
const idByContent = async (content: string) =>
  (
    await seed<{ id: string; externalId: string }[]>`
      select id, external_id from public.external_interactions where content = ${content}
        and provider in ('facebook_page', 'instagram_business')`
  )[0]!;
const posts = (suffix: string) =>
  meta.calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith(suffix)).length;

describe('Fase 4 · publicación en Facebook e Instagram', () => {
  it('Facebook: publica una sola vez y queda verificada', async () => {
    const i = await idByContent('Muy buen servicio');
    await approve(i.id, 'Gracias, Luis. ¡Te esperamos!');
    const out = await drain(QUEUES.publish, (j) => runPublish(deps, j));
    expect(out[0]).toMatchObject({ status: 'published' });
    expect(posts(`/${i.externalId}/comments`)).toBe(1);
    const [s] = await seed<
      { state: string }[]
    >`select state from public.external_interactions where id = ${i.id}`;
    expect(s!.state).toBe('published');
  });

  it('Instagram: si la conexión se corta tras escribir, consulta y no duplica', async () => {
    const i = await idByContent('Qué buena pinta');
    await approve(i.id, '¡Gracias! Te esperamos pronto.');
    meta.dropAfterWrite = true;
    const out = await drain(QUEUES.publish, (j) => runPublish(deps, j));
    expect(out[0]).toMatchObject({ status: 'published', viaStatusCheck: true });
    expect(posts(`/${i.externalId}/replies`)).toBe(1);
  });
});

describe('Fase 4 · webhooks de Meta', () => {
  const body = (commentId: string, time = 1763100000) => ({
    object: 'page',
    entry: [
      {
        id: '101',
        time,
        changes: [
          {
            field: 'feed',
            value: { item: 'comment', verb: 'add', comment_id: commentId, post_id: '101_1' },
          },
        ],
      },
    ],
  });

  it('responde al desafío de verificación solo con el token correcto', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4815162342`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('4815162342');
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=otro-token-cualquiera&hub.challenge=1',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('rechaza avisos sin firma válida y no encola nada', async () => {
    const r = await hook(body('101_1_777'), 'secreto-equivocado-123456');
    expect(r.statusCode).toBe(401);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/meta',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body('101_1_778')),
    });
    expect(unsigned.statusCode).toBe(401);
    expect(queue.take(QUEUES.sync)).toHaveLength(0);
    expect(await seed`select 1 from private.webhook_events`).toHaveLength(0);
  });

  it('un aviso firmado lanza una sincronización; el reintento de Meta no la repite', async () => {
    const c = meta.addComment(meta.page('101')!.posts[0]!, { text: 'Comentario por aviso' });
    const r = await hook(body(c.id));
    expect(r.statusCode).toBe(200);
    const runs = queue.take(QUEUES.sync);
    expect(runs).toHaveLength(1);
    const [run] = await seed<{ trigger: string; connectedAccountId: string }[]>`
      select trigger, connected_account_id from public.provider_sync_runs where id = ${runs[0]!.id}`;
    expect(run).toMatchObject({ trigger: 'webhook', connectedAccountId: fbAccount });
    expect(await runSync(deps, runs[0]!.id)).toMatchObject({ status: 'succeeded' });
    expect((await idByContent('Comentario por aviso')).externalId).toBe(c.id);

    const again = await hook(body(c.id));
    expect(again.statusCode).toBe(200);
    expect(queue.take(QUEUES.sync)).toHaveLength(0);
    const ev = await seed<
      { matchedAccounts: number }[]
    >`select matched_accounts from private.webhook_events`;
    expect(ev).toEqual([{ matchedAccounts: 1 }]);
  });
});

describe('Fase 4 · caducidad y desconexión de Meta', () => {
  it('un token invalidado por Meta deja la fuente como «credenciales caducadas»', async () => {
    const saved = new Map(meta.tokens);
    meta.invalidateAll();
    const r = await call('POST', `/v1/connections/${fbAccount}/sync`, w.users.adminA);
    expect([200, 202]).toContain(r.status);
    const [res] = await drain(QUEUES.sync, (id) => runSync(deps, id));
    expect(res).toMatchObject({ status: 'failed', error: { kind: 'credentials_expired' } });
    const [a] = await seed<
      { status: string }[]
    >`select status from public.connected_accounts where id = ${fbAccount}`;
    expect(a!.status).toBe('credentials_expired');
    for (const [k, v] of saved) meta.tokens.set(k, v);
  });

  it('desconectar la última fuente da de baja la página, revoca y borra la credencial', async () => {
    const d1 = await call('POST', `/v1/connections/${fbAccount}/disconnect`, w.users.adminA);
    expect(d1.body).toMatchObject({ ok: true, credentialReleased: false });
    expect(meta.page('101')!.subscribed).toBe(true); // Instagram sigue usando la página
    const revokedBefore = meta.revokedUsers;
    const d2 = await call('POST', `/v1/connections/${igAccount}/disconnect`, w.users.adminA);
    expect(d2.body).toMatchObject({ ok: true, credentialReleased: true, revokedAtProvider: true });
    expect(meta.page('101')!.subscribed).toBe(false);
    expect(meta.revokedUsers).toBe(revokedBefore + 1);
    expect(
      await seed`select 1 from private.provider_credentials where id = ${credentialId}`,
    ).toHaveLength(0);
  });

  it('no revoca la app si otra autorización vigente es del mismo usuario de Facebook', async () => {
    const { cb: a } = await authorize();
    const { cb: b } = await authorize();
    const first = new URL(a.location!).searchParams.get('meta')!;
    const second = new URL(b.location!).searchParams.get('meta')!;
    await seed`update private.provider_credentials set created_at = now() - interval '2 hours' where id = ${first}`;
    const before = meta.revokedUsers;
    expect(await sweepCredentials(app.deps.sql, app.deps.integrations, 60)).toBe(1);
    expect(meta.revokedUsers).toBe(before);
    await seed`update private.provider_credentials set created_at = now() - interval '2 hours' where id = ${second}`;
    expect(await sweepCredentials(app.deps.sql, app.deps.integrations, 60)).toBe(1);
    expect(meta.revokedUsers).toBe(before + 1);
  });
});
