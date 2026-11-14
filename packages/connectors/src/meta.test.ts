import { describe, expect, it } from 'vitest';
import {
  FacebookPageConnector,
  InstagramBusinessConnector,
  META_SCOPES,
  MetaGraph,
  mapMetaError,
  metaWebhookChallenge,
  parseMetaWebhook,
  verifyMetaSignature,
} from './meta';
import { FakeMetaApi } from './testing/meta-fake';

const redirectUri = 'http://localhost:8787/v1/oauth/meta/callback';

function setup(api = new FakeMetaApi()) {
  const opts = { appId: api.appId, appSecret: api.appSecret, fetch: api.fetch };
  return {
    api,
    graph: new MetaGraph(opts),
    fb: new FacebookPageConnector(opts),
    ig: new InstagramBusinessConnector(opts),
  };
}

async function login(s = setup(), scopes: readonly string[] = META_SCOPES) {
  const url = s.graph.authorizationUrl(redirectUri, 'st');
  const { code } = s.api.authorize(url, scopes);
  const user = await s.graph.exchangeCode(code, redirectUri);
  if (!user.ok) throw new Error(user.error.message);
  const pages = await s.graph.listPages(user.value.accessToken);
  if (!pages.ok) throw new Error(pages.error.message);
  const page = pages.value.find((p) => p.id === '101')!;
  return {
    ...s,
    user: user.value,
    pages: pages.value,
    pageCreds: { accessToken: page.accessToken, scopes: user.value.scopes },
  };
}

describe('Meta · inicio de sesión', () => {
  it('construye el diálogo con los permisos, el state y la versión v26.0', () => {
    const { graph } = setup();
    const u = new URL(graph.authorizationUrl(redirectUri, 'abc'));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(u.searchParams.get('state')).toBe('abc');
    expect(u.searchParams.get('scope')!.split(',')).toEqual([...META_SCOPES]);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.toString()).not.toContain('secret');
  });

  it('canjea el código por un token largo y lee los permisos concedidos', async () => {
    const { user, api } = await login();
    expect(user.accessToken).toMatch(/^EAAUserLong/);
    expect(user.scopes).toEqual([...META_SCOPES]);
    expect(user.meta?.userId).toBe(api.user.id);
    expect(user.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 86400_000);
    // Toda llamada con token lleva appsecret_proof y el token nunca va en la URL.
    for (const c of api.calls.filter((x) => x.auth)) {
      expect(c.url).toContain('appsecret_proof=');
      expect(c.url).not.toMatch(/EAA/);
    }
  });

  it('un código ya usado se rechaza', async () => {
    const s = setup();
    const { code } = s.api.authorize(s.graph.authorizationUrl(redirectUri, 'x'));
    expect((await s.graph.exchangeCode(code, redirectUri)).ok).toBe(true);
    const again = await s.graph.exchangeCode(code, redirectUri);
    expect(again.ok).toBe(false);
  });

  it('lista páginas con su token y la cuenta de Instagram vinculada', async () => {
    const { pages, fb, ig, user } = await login();
    expect(pages.map((p) => p.id)).toEqual(['101', '102']);
    expect(pages[0]!.instagram?.id).toBe('178414000001');
    const fbAcc = await fb.listAccounts(user);
    const igAcc = await ig.listAccounts(user);
    expect(fbAcc.ok && fbAcc.value.map((a) => a.externalId)).toEqual(['101', '102']);
    expect(igAcc.ok && igAcc.value).toEqual([
      {
        externalId: '178414000001',
        displayName: '@restaurante_ficticio',
        type: 'instagram_business',
      },
    ]);
  });

  it('sin pages_manage_engagement no se concede publish_reply en Facebook', async () => {
    const { fb, user } = await login(
      setup(),
      META_SCOPES.filter((s) => s !== 'pages_manage_engagement'),
    );
    const caps = await fb.getCapabilities(user);
    expect(caps.granted?.has('fetch_interactions')).toBe(true);
    expect(caps.granted?.has('publish_reply')).toBe(false);
  });
});

describe('Facebook · comentarios', () => {
  it('importa comentarios de primer nivel y toma la respuesta de la página como existente', async () => {
    const s = await login();
    const post = s.api.page('101')!.posts[0]!;
    const a = s.api.addComment(post, { text: 'Comentario ficticio A', fromName: 'Ana Ficticia' });
    s.api.addComment(post, { text: 'Comentario ficticio B' });
    a.replies.push({
      id: `${a.id}_9`,
      text: 'Gracias, Ana',
      createdAt: new Date().toISOString(),
      fromId: '101',
      fromName: 'Página',
      replies: [],
    });
    // Un comentario de la propia página no es una interacción.
    s.api.addComment(post, { text: 'Aviso de la página', fromId: '101' });
    const r = await s.fb.fetchInteractions({ credentials: s.pageCreds, accountExternalId: '101' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(2);
    const ia = r.value.items.find((i) => i.externalId === a.id)!;
    expect(ia.kind).toBe('comment');
    expect(ia.authorName).toBe('Ana Ficticia');
    expect(ia.externalParentId).toBe('101_1');
    expect(ia.existingReply?.content).toBe('Gracias, Ana');
  });

  it('recorre varias publicaciones con el cursor', async () => {
    const s = await login();
    const p = s.api.page('101')!;
    p.posts.push({ id: '101_2', comments: [] });
    s.api.addComment(p.posts[0]!, { text: 'uno' });
    s.api.addComment(p.posts[1]!, { text: 'dos' });
    const first = await s.fb.fetchInteractions({
      credentials: s.pageCreds,
      accountExternalId: '101',
    });
    expect(first.ok && first.value.nextCursor).toBeTruthy();
    const second = await s.fb.fetchInteractions({
      credentials: s.pageCreds,
      accountExternalId: '101',
      cursor: first.ok ? first.value.nextCursor : undefined,
    });
    expect(second.ok && second.value.nextCursor).toBeUndefined();
    const texts = [first, second].flatMap((x) => (x.ok ? x.value.items.map((i) => i.content) : []));
    expect(texts.sort()).toEqual(['dos', 'uno']);
  });

  it('publica una respuesta y la verifica por su texto', async () => {
    const s = await login();
    const c = s.api.addComment(s.api.page('101')!.posts[0]!, { text: '¿Abrís el lunes?' });
    const params = {
      credentials: s.pageCreds,
      accountExternalId: '101',
      interactionExternalId: c.id,
      idempotencyKey: 'job-1',
    };
    const before = await s.fb.getPublicationStatus({ ...params, expectedContent: 'Sí, de 9 a 14' });
    expect(before.ok && before.value.status).toBe('not_found');
    const r = await s.fb.publishReply({ ...params, content: 'Sí, de 9 a 14' });
    expect(r.ok && r.value.status).toBe('published');
    const after = await s.fb.getPublicationStatus({
      ...params,
      expectedContent: 'Sí,  de 9 a 14 ',
    });
    expect(after.ok && after.value.status).toBe('published');
    expect(c.replies).toHaveLength(1);
  });

  it('un corte tras escribir es ambiguo (no éxito ni fallo)', async () => {
    const s = await login();
    const c = s.api.addComment(s.api.page('101')!.posts[0]!, { text: 'Hola' });
    s.api.dropAfterWrite = true;
    const r = await s.fb.publishReply({
      credentials: s.pageCreds,
      accountExternalId: '101',
      interactionExternalId: c.id,
      content: 'Respuesta',
      idempotencyKey: 'k',
    });
    expect(!r.ok && r.error.kind).toBe('ambiguous');
    expect(c.replies).toHaveLength(1);
  });

  it('un token invalidado se informa como credenciales caducadas', async () => {
    const s = await login();
    s.api.invalidateAll();
    const r = await s.fb.fetchInteractions({ credentials: s.pageCreds, accountExternalId: '101' });
    expect(!r.ok && r.error.kind).toBe('credentials_expired');
    expect(!r.ok && r.error.message).not.toMatch(/EAA/);
  });

  it('rechaza identificadores con caracteres no numéricos', async () => {
    const s = await login();
    const r = await s.fb.publishReply({
      credentials: s.pageCreds,
      accountExternalId: '101',
      interactionExternalId: '../me/permissions',
      content: 'x',
      idempotencyKey: 'k',
    });
    expect(!r.ok && r.error.kind).toBe('invalid_request');
    expect(s.api.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('Instagram · comentarios', () => {
  it('importa, responde con /replies y verifica', async () => {
    const s = await login();
    const media = s.api.page('101')!.instagram!.media[0]!;
    const c = s.api.addComment(media, { text: 'Qué buena pinta', fromName: 'cliente_ficticio' });
    const r = await s.ig.fetchInteractions({
      credentials: s.pageCreds,
      accountExternalId: '178414000001',
    });
    expect(r.ok && r.value.items.map((i) => [i.externalId, i.authorName])).toEqual([
      [c.id, '@cliente_ficticio'],
    ]);
    const params = {
      credentials: s.pageCreds,
      accountExternalId: '178414000001',
      interactionExternalId: c.id,
      idempotencyKey: 'j',
    };
    const pub = await s.ig.publishReply({ ...params, content: '¡Gracias!' });
    expect(pub.ok).toBe(true);
    expect(s.api.calls.at(-1)!.url).toMatch(/\/replies\?/);
    const st = await s.ig.getPublicationStatus({ ...params, expectedContent: '¡Gracias!' });
    expect(st.ok && st.value.status).toBe('published');
    const again = await s.ig.fetchInteractions({
      credentials: s.pageCreds,
      accountExternalId: '178414000001',
    });
    expect(again.ok && again.value.items[0]!.existingReply?.content).toBe('¡Gracias!');
  });
});

describe('Meta · webhooks', () => {
  const body = {
    object: 'page',
    entry: [
      {
        id: '101',
        time: 1763100000,
        changes: [
          {
            field: 'feed',
            value: { item: 'comment', verb: 'add', comment_id: '101_1_55', post_id: '101_1' },
          },
          { field: 'feed', value: { item: 'reaction', verb: 'add' } },
        ],
      },
    ],
  };

  it('acepta solo la firma correcta, calculada sobre el cuerpo sin modificar', () => {
    const api = new FakeMetaApi();
    const { raw, sig } = api.webhook(body);
    expect(verifyMetaSignature(raw, sig, api.appSecret)).toBe(true);
    expect(verifyMetaSignature(raw, sig, 'otro-secreto')).toBe(false);
    expect(
      verifyMetaSignature(Buffer.from(JSON.stringify(body, null, 2)), sig, api.appSecret),
    ).toBe(false);
    expect(verifyMetaSignature(raw, undefined, api.appSecret)).toBe(false);
    expect(verifyMetaSignature(raw, 'sha256=zz', api.appSecret)).toBe(false);
  });

  it('normaliza comentarios y produce el mismo id para un reintento', () => {
    const raw = Buffer.from(JSON.stringify(body));
    const a = parseMetaWebhook(raw);
    const b = parseMetaWebhook(raw);
    expect(a.ok && a.value).toHaveLength(1);
    expect(a.ok && a.value[0]).toMatchObject({
      provider: 'facebook_page',
      accountExternalId: '101',
      interactionExternalId: '101_1_55',
      type: 'interaction_created',
    });
    expect(a.ok && b.ok && a.value[0]!.eventId).toBe(b.ok && b.value[0]!.eventId);
    const ig = parseMetaWebhook(
      Buffer.from(
        JSON.stringify({
          object: 'instagram',
          entry: [
            {
              id: '178414000001',
              time: 1,
              changes: [{ field: 'comments', value: { id: '1790_1' } }],
            },
          ],
        }),
      ),
    );
    expect(ig.ok && ig.value[0]!.provider).toBe('instagram_business');
    expect(parseMetaWebhook(Buffer.from('no-json')).ok).toBe(false);
  });

  it('el desafío de verificación solo se devuelve con el token correcto', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok-123', 'hub.challenge': '98765' };
    expect(metaWebhookChallenge(q, 'tok-123')).toBe('98765');
    expect(metaWebhookChallenge({ ...q, 'hub.verify_token': 'tok-124' }, 'tok-123')).toBeNull();
    expect(metaWebhookChallenge({ ...q, 'hub.challenge': '<script>' }, 'tok-123')).toBeNull();
  });
});

describe('mapMetaError', () => {
  const res = (status: number) => ({ status, headers: new Headers() });
  it('clasifica los códigos de la Graph API', () => {
    expect(mapMetaError(res(400), { code: 190 }, false, false).kind).toBe('credentials_expired');
    expect(mapMetaError(res(400), { code: 4 }, false, false).kind).toBe('rate_limited');
    expect(mapMetaError(res(400), { code: 32 }, false, false).kind).toBe('rate_limited');
    expect(mapMetaError(res(403), { code: 200 }, false, false).kind).toBe(
      'insufficient_permissions',
    );
    expect(mapMetaError(res(400), { code: 10 }, false, false).kind).toBe(
      'insufficient_permissions',
    );
    expect(mapMetaError(res(400), { code: 100, error_subcode: 33 }, false, false).kind).toBe(
      'not_found',
    );
    expect(mapMetaError(res(500), { code: 2 }, false, false).kind).toBe('transient');
    expect(mapMetaError(res(500), { code: 2 }, true, false).kind).toBe('ambiguous');
    expect(
      mapMetaError(res(400), { code: 190, message: 'token EAAabc123 caducado' }, false, false)
        .message,
    ).not.toContain('EAAabc123');
  });
});
