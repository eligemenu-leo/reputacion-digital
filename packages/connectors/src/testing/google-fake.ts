/**
 * SOLO PRUEBAS. Servidor falso de las API de Google (OAuth + Business Profile)
 * que se inyecta como `fetch`. Nunca contacta con Google ni se usa fuera de
 * los tests: sirve para comprobar el conector y el flujo completo sin acceso real.
 */
import { createHash } from 'node:crypto';
import { GOOGLE_ENDPOINTS, GOOGLE_SCOPE } from '../google';

export interface FakeReview {
  reviewId: string;
  displayName?: string;
  isAnonymous?: boolean;
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  createTime: string;
  updateTime?: string;
  reply?: {
    comment: string;
    updateTime: string;
    reviewReplyState?: string;
    policyViolation?: string;
  };
}

export interface FakeLocation {
  name: string; // locations/L
  title: string;
  verified: boolean;
  reviews: FakeReview[];
}

type Failure = { status: number; body?: unknown; times?: number } | 'network';

export class FakeGoogleApi {
  calls: { method: string; url: string; body?: string }[] = [];
  accounts: { name: string; accountName: string; type: string }[] = [
    { name: 'accounts/111', accountName: 'Cuenta de prueba (ficticia)', type: 'PERSONAL' },
  ];
  locations = new Map<string, FakeLocation[]>();
  codes = new Map<string, { verifier: string; scope: string }>();
  tokens = new Map<string, { refresh: string; expires: number }>();
  refreshTokens = new Set<string>();
  revoked: string[] = [];
  /** Fallos programados por clave «MÉTODO ruta» (la ruta sin query). */
  failures = new Map<string, Failure>();
  /** Si es true, el PUT de la respuesta se aplica pero la conexión «se corta». */
  dropAfterWrite = false;
  replyState: 'APPROVED' | 'PENDING' | 'REJECTED' = 'APPROVED';
  private seq = 0;

  constructor(
    public clientId = 'test-client-id',
    public clientSecret = 'test-client-secret',
  ) {
    this.locations.set('accounts/111', [
      { name: 'locations/222', title: 'Restaurante Ficticio Centro', verified: true, reviews: [] },
      { name: 'locations/333', title: 'Restaurante Ficticio Puerto', verified: false, reviews: [] },
    ]);
  }

  /** Simula que el usuario autoriza en la pantalla de Google y devuelve el `code`. */
  authorize(authorizationUrl: string, scope = GOOGLE_SCOPE): { code: string; state: string } {
    const u = new URL(authorizationUrl);
    const challenge = u.searchParams.get('code_challenge')!;
    const code = `code-${++this.seq}`;
    this.codes.set(code, { verifier: challenge, scope });
    return { code, state: u.searchParams.get('state')! };
  }

  failNext(key: string, f: Failure) {
    this.failures.set(key, f);
  }

  location(path: string) {
    const parts = path.split('/');
    const acc = parts.slice(0, 2).join('/');
    const loc = parts.slice(2).join('/');
    return this.locations.get(acc)?.find((l) => l.name === loc);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.calls.push({ method, url: url.toString(), body });
    const key = `${method} ${url.origin}${url.pathname}`;
    const f = this.failures.get(key);
    if (f) {
      if (f === 'network' || !f.times || f.times <= 1) this.failures.delete(key);
      else f.times--;
      if (f === 'network') throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
      return json(f.status, f.body ?? { error: { message: 'fallo simulado', status: 'INTERNAL' } });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const E = GOOGLE_ENDPOINTS;

    if (url.toString().startsWith(E.token)) return this.token(new URLSearchParams(body));
    if (url.toString().startsWith(E.revoke)) {
      this.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return json(200, {});
    }
    if (url.toString().startsWith(E.tokenInfo)) {
      const t = this.tokens.get(url.searchParams.get('access_token') ?? '');
      return t && t.expires > Date.now()
        ? json(200, { scope: GOOGLE_SCOPE })
        : json(400, { error: 'invalid_token' });
    }
    const token = auth?.replace(/^Bearer /, '') ?? '';
    const t = this.tokens.get(token);
    if (!t || t.expires < Date.now()) {
      return json(401, {
        error: {
          message: 'Request had invalid authentication credentials.',
          status: 'UNAUTHENTICATED',
        },
      });
    }

    if (url.toString().startsWith(`${E.accounts}/accounts`)) {
      return json(200, { accounts: this.accounts });
    }
    let m = new RegExp(`^${esc(E.businessInfo)}/(accounts/[^/]+)/locations$`).exec(
      url.origin + url.pathname,
    );
    if (m) {
      if (!url.searchParams.get('readMask'))
        return json(400, { error: { message: 'readMask required' } });
      return json(200, {
        locations: (this.locations.get(m[1]!) ?? []).map((l) => ({
          name: l.name,
          title: l.title,
          storefrontAddress: {
            addressLines: ['Calle Inventada 1'],
            locality: 'Ciudad Ficticia',
            postalCode: '00000',
          },
          metadata: { hasVoiceOfMerchant: l.verified },
        })),
      });
    }
    m = new RegExp(`^${esc(E.verifications)}/(locations/[^/]+)/VoiceOfMerchantState$`).exec(
      url.origin + url.pathname,
    );
    if (m) {
      const loc = [...this.locations.values()].flat().find((l) => l.name === m![1]);
      return json(
        200,
        loc?.verified
          ? { hasVoiceOfMerchant: true, hasBusinessAuthority: true }
          : { verify: { hasPendingVerification: false } },
      );
    }
    m = new RegExp(
      `^${esc(E.reviews)}/(accounts/[^/]+/locations/[^/]+)/reviews(?:/([\\w-]+)(/reply)?)?$`,
    ).exec(url.origin + url.pathname);
    if (m) {
      const loc = this.location(m[1]!);
      if (!loc)
        return json(404, {
          error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' },
        });
      if (!m[2]) {
        const sorted = [...loc.reviews].sort((a, b) =>
          (b.updateTime ?? b.createTime).localeCompare(a.updateTime ?? a.createTime),
        );
        const size = Number(url.searchParams.get('pageSize') ?? 50);
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        const page = sorted.slice(start, start + size);
        return json(200, {
          reviews: page.map(toApi),
          totalReviewCount: sorted.length,
          nextPageToken: start + size < sorted.length ? String(start + size) : undefined,
        });
      }
      const r = loc.reviews.find((x) => x.reviewId === m![2]);
      if (!r)
        return json(404, {
          error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' },
        });
      if (m[3] && method === 'PUT') {
        if (!loc.verified) {
          return json(400, {
            error: { message: 'Location is not verified.', status: 'FAILED_PRECONDITION' },
          });
        }
        const comment = (JSON.parse(body ?? '{}') as { comment?: string }).comment ?? '';
        r.reply = {
          comment,
          updateTime: new Date().toISOString(),
          reviewReplyState: this.replyState,
          policyViolation: this.replyState === 'REJECTED' ? 'PERSONAL_INFO' : undefined,
        };
        if (this.dropAfterWrite) {
          this.dropAfterWrite = false;
          throw Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          });
        }
        return json(200, r.reply);
      }
      // get no devuelve reviewReplyState (según la documentación).
      const api = toApi(r);
      if (api.reviewReply)
        delete (api.reviewReply as { reviewReplyState?: string }).reviewReplyState;
      return json(200, api);
    }
    return json(404, { error: { message: `ruta no simulada: ${key}` } });
  };

  private token(form: URLSearchParams) {
    if (
      form.get('client_id') !== this.clientId ||
      form.get('client_secret') !== this.clientSecret
    ) {
      return json(401, { error: 'invalid_client', error_description: 'Unauthorized' });
    }
    const issue = (scope: string, withRefresh: boolean) => {
      const access = `ya29.fake-access-${++this.seq}`;
      const refresh = withRefresh ? `1//fake-refresh-${this.seq}` : undefined;
      this.tokens.set(access, { refresh: refresh ?? '', expires: Date.now() + 3600_000 });
      if (refresh) this.refreshTokens.add(refresh);
      return json(200, {
        access_token: access,
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
        ...(refresh ? { refresh_token: refresh } : {}),
      });
    };
    if (form.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(form.get('code') ?? '');
      if (!c) return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
      this.codes.delete(form.get('code')!);
      const verifier = form.get('code_verifier') ?? '';
      // Comprueba PKCE S256 como haría Google.
      const expected = sha256url(verifier);
      if (expected !== c.verifier)
        return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      return issue(c.scope, true);
    }
    if (form.get('grant_type') === 'refresh_token') {
      const rt = form.get('refresh_token') ?? '';
      if (!this.refreshTokens.has(rt) || this.revoked.includes(rt)) {
        return json(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        });
      }
      return issue(GOOGLE_SCOPE, false);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  /** Caduca todos los tokens de acceso emitidos (para probar el refresco). */
  expireAccessTokens() {
    for (const t of this.tokens.values()) t.expires = 0;
  }
}

function sha256url(v: string) {
  return createHash('sha256').update(v).digest('base64url');
}

function toApi(r: FakeReview) {
  return {
    name: `reviews/${r.reviewId}`,
    reviewId: r.reviewId,
    reviewer: {
      displayName: r.isAnonymous ? 'Un usuario de Google' : r.displayName,
      isAnonymous: Boolean(r.isAnonymous),
    },
    starRating: r.starRating,
    comment: r.comment,
    createTime: r.createTime,
    updateTime: r.updateTime ?? r.createTime,
    reviewReply: r.reply ? { ...r.reply } : undefined,
  } as Record<string, unknown> & { reviewReply?: Record<string, unknown> };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
