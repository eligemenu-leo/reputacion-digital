import { describe, expect, it } from 'vitest';
import { GoogleBusinessConnector, GOOGLE_ENDPOINTS, GOOGLE_SCOPE, mapGoogleError } from './google';
import { FakeGoogleApi } from './testing/google-fake';

const LOC = 'accounts/111/locations/222';
const redirectUri = 'http://localhost:8787/v1/oauth/google/callback';

async function connected(api = new FakeGoogleApi()) {
  const c = new GoogleBusinessConnector({
    clientId: api.clientId,
    clientSecret: api.clientSecret,
    fetch: api.fetch,
  });
  const start = await c.connect({ redirectUri, state: 'st' });
  if (!start.ok) throw new Error('connect');
  const { code } = api.authorize(start.value.authorizationUrl);
  const creds = await c.completeConnect({
    code,
    redirectUri,
    codeVerifier: start.value.codeVerifier,
  });
  if (!creds.ok) throw new Error(creds.error.message);
  return { api, c, creds: creds.value, start: start.value };
}

function review(id: string, iso: string) {
  return {
    reviewId: id,
    displayName: `Autor ${id}`,
    starRating: 'FOUR' as const,
    comment: `Reseña ficticia ${id}`,
    createTime: iso,
  };
}

describe('GoogleBusinessConnector · OAuth', () => {
  it('pide solo business.manage, acceso offline y PKCE S256', async () => {
    const { start } = await connected();
    const u = new URL(start.authorizationUrl);
    expect(u.origin + u.pathname).toBe(GOOGLE_ENDPOINTS.authorize);
    expect(u.searchParams.get('scope')).toBe(GOOGLE_SCOPE);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('st');
    expect(start.codeVerifier!.length).toBeGreaterThanOrEqual(43);
    expect(u.toString()).not.toContain(start.codeVerifier!);
  });

  it('canjea el código con el verificador y rechaza un verificador distinto', async () => {
    const { creds, api } = await connected();
    expect(creds.refreshToken).toMatch(/^1\/\//);
    expect(creds.scopes).toEqual([GOOGLE_SCOPE]);
    const c = new GoogleBusinessConnector({
      clientId: api.clientId,
      clientSecret: api.clientSecret,
      fetch: api.fetch,
    });
    const s = await c.connect({ redirectUri, state: 'x' });
    const { code } = api.authorize(s.ok ? s.value.authorizationUrl : '');
    const bad = await c.completeConnect({ code, redirectUri, codeVerifier: 'otro' });
    expect(bad.ok).toBe(false);
  });

  it('refresca el token y trata invalid_grant como credenciales caducadas', async () => {
    const { c, creds, api } = await connected();
    const r = await c.refreshCredentials(creds);
    expect(r.ok && r.value.accessToken !== creds.accessToken).toBe(true);
    expect(r.ok && r.value.refreshToken).toBe(creds.refreshToken);
    await c.disconnect(creds);
    expect(api.revoked).toContain(creds.refreshToken);
    const after = await c.refreshCredentials(creds);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.kind).toBe('credentials_expired');
  });
});

describe('GoogleBusinessConnector · lectura', () => {
  it('lista cuentas y ubicaciones con su aptitud para responder', async () => {
    const { c, creds } = await connected();
    const acc = await c.listAccounts(creds);
    expect(acc.ok && acc.value[0]!.externalId).toBe('accounts/111');
    const locs = await c.listLocations(creds, 'accounts/111');
    expect(locs.ok).toBe(true);
    if (!locs.ok) return;
    expect(locs.value.map((l) => [l.externalId, l.canReply])).toEqual([
      [LOC, true],
      ['accounts/111/locations/333', false],
    ]);
    expect(locs.value[1]!.ineligibilityReason).toContain('no está verificada');
  });

  it('normaliza reseñas, oculta autores anónimos, pagina y se detiene en `since`', async () => {
    const { c, creds, api } = await connected();
    const loc = api.location(LOC)!;
    for (let i = 1; i <= 7; i++) loc.reviews.push(review(`r${i}`, `2026-11-0${i}T10:00:00Z`));
    loc.reviews.push({
      ...review('anon', '2026-11-08T10:00:00Z'),
      isAnonymous: true,
      starRating: 'ONE',
      comment: undefined,
    });
    loc.reviews[0]!.reply = { comment: 'Gracias', updateTime: '2026-11-02T00:00:00Z' };
    const p1 = await c.fetchInteractions({
      credentials: creds,
      accountExternalId: LOC,
      pageSize: 5,
    });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.value.items[0]).toMatchObject({
      externalId: 'anon',
      authorName: undefined,
      rating: 1,
      content: null,
    });
    expect(p1.value.nextCursor).toBe('5');
    const p2 = await c.fetchInteractions({
      credentials: creds,
      accountExternalId: LOC,
      pageSize: 5,
      cursor: '5',
    });
    const r1 = p2.ok ? p2.value.items.find((i) => i.externalId === 'r1') : undefined;
    expect(r1).toMatchObject({ rating: 4, ratingScale: 5, existingReply: { content: 'Gracias' } });
    const inc = await c.fetchInteractions({
      credentials: creds,
      accountExternalId: LOC,
      since: new Date('2026-11-06T00:00:00Z'),
    });
    expect(inc.ok && inc.value.items.map((i) => i.externalId)).toEqual(['anon', 'r7', 'r6']);
    expect(inc.ok && inc.value.nextCursor).toBeUndefined();
  });

  it('rechaza rutas e identificadores manipulados antes de llamar a Google', async () => {
    const { c, creds, api } = await connected();
    const before = api.calls.length;
    const r = await c.fetchInteractions({
      credentials: creds,
      accountExternalId: 'accounts/1/../../x',
    });
    expect(r.ok).toBe(false);
    const p = await c.publishReply({
      credentials: creds,
      accountExternalId: LOC,
      interactionExternalId: '../reply',
      content: 'x',
      idempotencyKey: 'k',
    });
    expect(p.ok).toBe(false);
    expect(api.calls.length).toBe(before);
  });
});

describe('GoogleBusinessConnector · publicación', () => {
  const base = (creds: Awaited<ReturnType<typeof connected>>['creds']) => ({
    credentials: creds,
    accountExternalId: LOC,
    interactionExternalId: 'r1',
    idempotencyKey: 'job-1',
  });

  it('publica con PUT y verifica que el texto visible es el aprobado', async () => {
    const { c, creds, api } = await connected();
    api.location(LOC)!.reviews.push(review('r1', '2026-11-01T10:00:00Z'));
    const r = await c.publishReply({ ...base(creds), content: 'Gracias por tu visita' });
    expect(r.ok && r.value).toMatchObject({ status: 'published', providerState: 'visible' });
    const puts = api.calls.filter((x) => x.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.body!)).toEqual({ comment: 'Gracias por tu visita' });
    const st = await c.getPublicationStatus({
      ...base(creds),
      expectedContent: 'Gracias  por tu visita',
    });
    expect(st.ok && st.value.status).toBe('published');
    const other = await c.getPublicationStatus({ ...base(creds), expectedContent: 'Otro texto' });
    expect(other.ok && other.value.status).toBe('rejected');
  });

  it('distingue moderación pendiente, rechazo por política y ficha no verificada', async () => {
    const { c, creds, api } = await connected();
    api.location(LOC)!.reviews.push(review('r1', '2026-11-01T10:00:00Z'));
    api.replyState = 'PENDING';
    const p = await c.publishReply({ ...base(creds), content: 'Hola' });
    expect(p.ok && p.value.providerState).toBe('pending_moderation');
    api.replyState = 'REJECTED';
    const rej = await c.publishReply({ ...base(creds), content: 'Hola' });
    expect(!rej.ok && rej.error).toMatchObject({
      kind: 'provider_error',
      providerCode: 'PERSONAL_INFO',
      retryable: false,
    });
    api.location('accounts/111/locations/333')!.reviews.push(review('r9', '2026-11-01T10:00:00Z'));
    const unv = await c.publishReply({
      ...base(creds),
      accountExternalId: 'accounts/111/locations/333',
      interactionExternalId: 'r9',
      content: 'Hola',
    });
    expect(!unv.ok && unv.error.kind).toBe('invalid_request');
  });

  it('un corte tras escribir o un 5xx en la escritura es «ambiguo», nunca «fallido»', async () => {
    const { c, creds, api } = await connected();
    api.location(LOC)!.reviews.push(review('r1', '2026-11-01T10:00:00Z'));
    api.dropAfterWrite = true;
    const r = await c.publishReply({ ...base(creds), content: 'Hola' });
    expect(!r.ok && r.error.kind).toBe('ambiguous');
    // El estado remoto confirma que sí se publicó.
    const st = await c.getPublicationStatus({ ...base(creds), expectedContent: 'Hola' });
    expect(st.ok && st.value.status).toBe('published');
    api.failNext(`PUT ${GOOGLE_ENDPOINTS.reviews}/${LOC}/reviews/r1/reply`, { status: 503 });
    const r5 = await c.publishReply({ ...base(creds), content: 'Hola' });
    expect(!r5.ok && r5.error.kind).toBe('ambiguous');
  });
});

describe('errores de Google', () => {
  const h = (n?: string) => new Headers(n ? { 'retry-after': n } : {});
  it('mapea estados HTTP y nunca deja tokens en el mensaje', () => {
    expect(mapGoogleError({ status: 401, headers: h() }, {}, false, false).kind).toBe(
      'credentials_expired',
    );
    expect(mapGoogleError({ status: 403, headers: h() }, {}, false, false).kind).toBe(
      'insufficient_permissions',
    );
    const rl = mapGoogleError(
      { status: 429, headers: h('30') },
      { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } },
      false,
      false,
    );
    expect(rl).toMatchObject({
      kind: 'rate_limited',
      retryAfterSec: 30,
      retryable: true,
      providerCode: 'RESOURCE_EXHAUSTED',
    });
    expect(mapGoogleError({ status: 502, headers: h() }, {}, false, false).kind).toBe('transient');
    const leak = mapGoogleError(
      { status: 400, headers: h() },
      { error: { message: 'bad token ya29.AbC-123 and 1//0gXyz' } },
      false,
      false,
    );
    expect(leak.message).not.toMatch(/ya29|1\/\//);
    expect(
      mapGoogleError({ status: 400, headers: h() }, { error: 'invalid_grant' }, false, true).kind,
    ).toBe('credentials_expired');
  });
});
