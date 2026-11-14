/**
 * Conector de Google Business Profile (API oficial, OAuth 2.0 con PKCE).
 *
 * Endpoints verificados el 14/11/2026 en developers.google.com/my-business:
 *  - Cuentas:      GET  mybusinessaccountmanagement.googleapis.com/v1/accounts
 *  - Ubicaciones:  GET  mybusinessbusinessinformation.googleapis.com/v1/{accounts/*}/locations (readMask)
 *  - Aptitud:      GET  mybusinessverifications.googleapis.com/v1/{locations/*}/VoiceOfMerchantState
 *  - Reseñas:      GET  mybusiness.googleapis.com/v4/{accounts/*}/{locations/*}/reviews (pageSize ≤ 50)
 *  - Responder:    PUT  …/reviews/{id}/reply  { comment }  (crea o sustituye: idempotente)
 *  - Scope:        https://www.googleapis.com/auth/business.manage
 *
 * Sin acceso aprobado por Google la API devuelve cuota 0 (429/403): el conector
 * lo informa tal cual y nunca simula éxito. Las notificaciones Pub/Sub de
 * reseñas nuevas no se implementan todavía (se sincroniza por sondeo).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  fail,
  notSupported,
  ok,
  type CapabilitySet,
  type Capability,
  type ConnectorError,
  type ConnectorHealth,
  type ExternalAccount,
  type ExternalLocation,
  type FetchPage,
  type FetchParams,
  type NormalizedInteraction,
  type OAuthStart,
  type ProviderConnector,
  type ProviderCredentials,
  type PublicationReceipt,
  type PublishParams,
  type Result,
} from './contract';
import { contentHash, normalizeText } from './hash';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/business.manage';

export interface GoogleEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  tokenInfo: string;
  accounts: string;
  businessInfo: string;
  verifications: string;
  reviews: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  tokenInfo: 'https://oauth2.googleapis.com/tokeninfo',
  accounts: 'https://mybusinessaccountmanagement.googleapis.com/v1',
  businessInfo: 'https://mybusinessbusinessinformation.googleapis.com/v1',
  verifications: 'https://mybusinessverifications.googleapis.com/v1',
  reviews: 'https://mybusiness.googleapis.com/v4',
};

export interface GoogleConnectorOptions {
  clientId: string;
  clientSecret: string;
  endpoints?: Partial<GoogleEndpoints>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SUPPORTED: Capability[] = [
  'oauth_connect',
  'list_accounts',
  'list_locations',
  'fetch_interactions',
  'fetch_interaction',
  'read_existing_replies',
  'publish_reply',
  'update_reply',
  'publication_status',
];

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

interface GReview {
  name?: string;
  reviewId: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime: string;
  updateTime?: string;
  reviewReply?: {
    comment?: string;
    updateTime?: string;
    reviewReplyState?: string;
    policyViolation?: string;
  };
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Divide "accounts/A/locations/L" en sus dos partes. */
export function splitLocationPath(path: string): { account: string; location: string } | null {
  const m = /^(accounts\/[^/]+)\/(locations\/[^/]+)$/.exec(path);
  return m ? { account: m[1]!, location: m[2]! } : null;
}

export class GoogleBusinessConnector implements ProviderConnector {
  readonly provider = 'google_business_profile' as const;
  private ep: GoogleEndpoints;
  private f: typeof fetch;

  constructor(private opts: GoogleConnectorOptions) {
    this.ep = { ...GOOGLE_ENDPOINTS, ...opts.endpoints };
    this.f = opts.fetch ?? fetch;
  }

  async getCapabilities(credentials?: ProviderCredentials): Promise<CapabilitySet> {
    const supported = new Set(SUPPORTED);
    return {
      provider: this.provider,
      supported,
      granted: credentials
        ? credentials.scopes.includes(GOOGLE_SCOPE)
          ? supported
          : new Set()
        : undefined,
      notes: [
        'Requiere acceso aprobado a la API de Google Business Profile.',
        'Solo se puede responder en ubicaciones verificadas (Voice of Merchant).',
        'Notificaciones en tiempo real (Pub/Sub) no implementadas: sincronización periódica.',
      ],
    };
  }

  // ---------------------------------------------------------------- OAuth
  async connect(params: { redirectUri: string; state: string }): Promise<Result<OAuthStart>> {
    const codeVerifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
    const u = new URL(this.ep.authorize);
    u.search = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: params.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: params.state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return ok({ authorizationUrl: u.toString(), state: params.state, codeVerifier });
  }

  async completeConnect(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<Result<ProviderCredentials>> {
    const res = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      ...(params.codeVerifier ? { code_verifier: params.codeVerifier } : {}),
    });
    if (!res.ok) return res;
    const t = res.value;
    if (!t.refresh_token) {
      return fail({
        kind: 'invalid_request',
        message: 'Google no devolvió un token de actualización; vuelve a autorizar el acceso',
        retryable: false,
      });
    }
    return ok(this.toCredentials(t, t.refresh_token));
  }

  async refreshCredentials(c: ProviderCredentials): Promise<Result<ProviderCredentials>> {
    if (!c.refreshToken) {
      return fail({
        kind: 'credentials_expired',
        message: 'No hay token de actualización',
        retryable: false,
      });
    }
    const res = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken,
    });
    if (!res.ok) return res;
    return ok(this.toCredentials(res.value, res.value.refresh_token ?? c.refreshToken, c.scopes));
  }

  async disconnect(c: ProviderCredentials): Promise<Result<void>> {
    const token = c.refreshToken ?? c.accessToken;
    const r = await this.request('POST', `${this.ep.revoke}`, {
      form: { token },
      auth: false,
    });
    // 400 invalid_token = ya estaba revocado: el resultado es el mismo.
    if (!r.ok && r.error.kind !== 'invalid_request') return fail(r.error);
    return ok(undefined);
  }

  async validateCredentials(c: ProviderCredentials): Promise<Result<{ grantedScopes: string[] }>> {
    const u = `${this.ep.tokenInfo}?${new URLSearchParams({ access_token: c.accessToken })}`;
    const r = await this.request<{ scope?: string }>('GET', u, { auth: false });
    if (!r.ok) {
      return fail(
        r.error.kind === 'invalid_request'
          ? { ...r.error, kind: 'credentials_expired', message: 'El token ya no es válido' }
          : r.error,
      );
    }
    return ok({ grantedScopes: (r.value.scope ?? '').split(' ').filter(Boolean) });
  }

  // ------------------------------------------------------- Cuentas y ubicaciones
  async listAccounts(c: ProviderCredentials): Promise<Result<ExternalAccount[]>> {
    const out: ExternalAccount[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ pageSize: '20', ...(pageToken ? { pageToken } : {}) });
      const r = await this.request<{
        accounts?: { name: string; accountName?: string; type?: string }[];
        nextPageToken?: string;
      }>('GET', `${this.ep.accounts}/accounts?${q}`, { credentials: c });
      if (!r.ok) return fail(r.error);
      for (const a of r.value.accounts ?? []) {
        out.push({
          externalId: a.name,
          displayName: a.accountName ?? a.name,
          type: a.type ?? 'UNKNOWN',
        });
      }
      pageToken = r.value.nextPageToken;
      if (!pageToken) break;
    }
    return ok(out);
  }

  async listLocations(
    c: ProviderCredentials,
    accountExternalId: string,
  ): Promise<Result<ExternalLocation[]>> {
    if (!/^accounts\/[^/]+$/.test(accountExternalId)) {
      return fail({
        kind: 'invalid_request',
        message: 'Cuenta de Google no válida',
        retryable: false,
      });
    }
    const out: ExternalLocation[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({
        readMask: 'name,title,storefrontAddress,metadata',
        pageSize: '100',
        ...(pageToken ? { pageToken } : {}),
      });
      const r = await this.request<{
        locations?: {
          name: string;
          title?: string;
          storefrontAddress?: { addressLines?: string[]; locality?: string; postalCode?: string };
          metadata?: { hasVoiceOfMerchant?: boolean };
        }[];
        nextPageToken?: string;
      }>('GET', `${this.ep.businessInfo}/${accountExternalId}/locations?${q}`, { credentials: c });
      if (!r.ok) return fail(r.error);
      for (const l of r.value.locations ?? []) {
        const vom = await this.voiceOfMerchant(c, l.name);
        const addr = l.storefrontAddress;
        out.push({
          externalId: `${accountExternalId}/${l.name}`,
          accountExternalId,
          displayName: l.title ?? l.name,
          address: addr
            ? [...(addr.addressLines ?? []), addr.postalCode, addr.locality]
                .filter(Boolean)
                .join(', ')
            : undefined,
          canReply: vom.canReply,
          ineligibilityReason: vom.reason,
        });
      }
      pageToken = r.value.nextPageToken;
      if (!pageToken) break;
    }
    return ok(out);
  }

  private async voiceOfMerchant(
    c: ProviderCredentials,
    locationName: string,
  ): Promise<{ canReply: boolean; reason?: string }> {
    const r = await this.request<{
      hasVoiceOfMerchant?: boolean;
      waitForVoiceOfMerchant?: object;
      verify?: { hasPendingVerification?: boolean };
      resolveOwnershipConflict?: object;
      complyWithGuidelines?: { recommendationReason?: string };
    }>('GET', `${this.ep.verifications}/${locationName}/VoiceOfMerchantState`, { credentials: c });
    if (!r.ok)
      return {
        canReply: false,
        reason: `No se pudo comprobar la verificación: ${r.error.message}`,
      };
    const v = r.value;
    if (v.hasVoiceOfMerchant) return { canReply: true };
    if (v.verify)
      return {
        canReply: false,
        reason: v.verify.hasPendingVerification
          ? 'Verificación de la ficha en curso'
          : 'La ficha no está verificada',
      };
    if (v.waitForVoiceOfMerchant)
      return { canReply: false, reason: 'Google está revisando la ficha' };
    if (v.resolveOwnershipConflict)
      return { canReply: false, reason: 'La ficha está duplicada o pertenece a otro propietario' };
    if (v.complyWithGuidelines)
      return {
        canReply: false,
        reason: `La ficha incumple las directrices de Google (${v.complyWithGuidelines.recommendationReason ?? 'sin motivo'})`,
      };
    return { canReply: false, reason: 'La ficha no tiene control de propietario en Google' };
  }

  // ------------------------------------------------------------- Reseñas
  async fetchInteractions(p: FetchParams): Promise<Result<FetchPage>> {
    const path = this.locationPath(p);
    if (!path.ok) return fail(path.error);
    const q = new URLSearchParams({
      pageSize: String(Math.min(p.pageSize ?? 50, 50)),
      orderBy: 'updateTime desc',
      ...(p.cursor ? { pageToken: p.cursor } : {}),
    });
    const r = await this.request<{ reviews?: GReview[]; nextPageToken?: string }>(
      'GET',
      `${this.ep.reviews}/${path.value}/reviews?${q}`,
      { credentials: p.credentials },
    );
    if (!r.ok) return fail(r.error);
    const items: NormalizedInteraction[] = [];
    let reachedOld = false;
    for (const g of r.value.reviews ?? []) {
      const updated = new Date(g.updateTime ?? g.createTime);
      // Orden por updateTime desc: lo anterior a `since` ya se procesó.
      if (p.since && updated < p.since) {
        reachedOld = true;
        break;
      }
      items.push(this.normalize(g, path.value));
    }
    return ok({
      items,
      nextCursor: reachedOld ? undefined : r.value.nextPageToken,
      complete: true,
    });
  }

  async fetchInteraction(
    p: FetchParams & { interactionExternalId: string },
  ): Promise<Result<NormalizedInteraction>> {
    const g = await this.getReview(p);
    if (!g.ok) return fail(g.error);
    const path = this.locationPath(p);
    return ok(this.normalize(g.value, path.ok ? path.value : ''));
  }

  private normalize(g: GReview, path: string): NormalizedInteraction {
    const rating = g.starRating ? STARS[g.starRating] : undefined;
    const content = g.comment?.trim() ? g.comment : null;
    const reply = g.reviewReply?.comment
      ? {
          content: g.reviewReply.comment,
          updatedAt: g.reviewReply.updateTime ? new Date(g.reviewReply.updateTime) : undefined,
        }
      : undefined;
    return {
      provider: this.provider,
      kind: 'review',
      externalId: g.reviewId,
      externalLocationId: path,
      authorName: g.reviewer?.isAnonymous ? undefined : g.reviewer?.displayName,
      content,
      rating,
      ratingScale: rating ? 5 : undefined,
      createdAt: new Date(g.createTime),
      updatedAt: g.updateTime ? new Date(g.updateTime) : undefined,
      existingReply: reply,
      contentHash: contentHash(content, rating ?? null),
      raw: {
        starRating: g.starRating ?? null,
        reviewReplyState: g.reviewReply?.reviewReplyState ?? null,
      },
    };
  }

  private async getReview(
    p: {
      credentials: ProviderCredentials;
      accountExternalId: string;
      locationExternalId?: string;
    } & {
      interactionExternalId: string;
    },
  ): Promise<Result<GReview>> {
    const path = this.locationPath(p);
    if (!path.ok) return fail(path.error);
    if (!/^[\w-]+$/.test(p.interactionExternalId)) {
      return fail({
        kind: 'invalid_request',
        message: 'Identificador de reseña no válido',
        retryable: false,
      });
    }
    return this.request<GReview>(
      'GET',
      `${this.ep.reviews}/${path.value}/reviews/${p.interactionExternalId}`,
      { credentials: p.credentials },
    );
  }

  // ------------------------------------------------------------ Publicación
  async publishReply(p: PublishParams): Promise<Result<PublicationReceipt>> {
    const path = this.locationPath(p);
    if (!path.ok) return fail(path.error);
    if (!/^[\w-]+$/.test(p.interactionExternalId)) {
      return fail({
        kind: 'invalid_request',
        message: 'Identificador de reseña no válido',
        retryable: false,
      });
    }
    const r = await this.request<NonNullable<GReview['reviewReply']>>(
      'PUT',
      `${this.ep.reviews}/${path.value}/reviews/${p.interactionExternalId}/reply`,
      { credentials: p.credentials, json: { comment: p.content }, write: true },
    );
    if (!r.ok) return fail(r.error);
    return this.receiptFrom(r.value, p.content, p.interactionExternalId);
  }

  async getPublicationStatus(
    p: Omit<PublishParams, 'content'> & { expectedContent: string },
  ): Promise<Result<PublicationReceipt>> {
    const g = await this.getReview(p);
    if (!g.ok) return fail(g.error);
    const reply = g.value.reviewReply;
    if (!reply?.comment) return ok({ status: 'not_found', observedAt: new Date() });
    return this.receiptFrom(reply, p.expectedContent, p.interactionExternalId);
  }

  private receiptFrom(
    reply: NonNullable<GReview['reviewReply']>,
    expected: string,
    reviewId: string,
  ): Result<PublicationReceipt> {
    if (reply.reviewReplyState === 'REJECTED') {
      return fail({
        kind: 'provider_error',
        message: `Google rechazó la respuesta (${reply.policyViolation ?? 'motivo no indicado'})`,
        providerCode: reply.policyViolation,
        retryable: false,
      });
    }
    const same = normalizeText(reply.comment) === normalizeText(expected);
    return ok({
      status: same ? 'published' : 'rejected',
      externalReplyId: `${reviewId}/reply`,
      publishedContent: reply.comment,
      observedAt: new Date(),
      providerState: same
        ? reply.reviewReplyState === 'PENDING'
          ? 'pending_moderation'
          : 'visible'
        : 'different_reply',
    });
  }

  async handleWebhook(): Promise<Result<never>> {
    return notSupported(this.provider, 'webhooks (Pub/Sub aún no implementado)');
  }

  async getHealthStatus(c: ProviderCredentials): Promise<ConnectorHealth> {
    const v = await this.validateCredentials(c);
    if (!v.ok) {
      return {
        status: v.error.kind === 'credentials_expired' ? 'credentials_expired' : 'temporary_error',
        checkedAt: new Date(),
        detail: v.error.message,
      };
    }
    return v.value.grantedScopes.includes(GOOGLE_SCOPE)
      ? { status: 'connected', checkedAt: new Date() }
      : {
          status: 'insufficient_access',
          checkedAt: new Date(),
          detail: 'Falta el permiso business.manage',
        };
  }

  // ------------------------------------------------------------ Internos
  private locationPath(p: {
    accountExternalId: string;
    locationExternalId?: string;
  }): Result<string> {
    const path = p.locationExternalId ?? p.accountExternalId;
    if (!splitLocationPath(path)) {
      return fail({
        kind: 'invalid_request',
        message: 'La fuente no apunta a una ubicación de Google válida',
        retryable: false,
      });
    }
    return ok(path);
  }

  private toCredentials(
    t: { access_token: string; expires_in?: number; scope?: string },
    refreshToken: string,
    fallbackScopes: string[] = [],
  ): ProviderCredentials {
    return {
      accessToken: t.access_token,
      refreshToken,
      expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
      scopes: t.scope ? t.scope.split(' ').filter(Boolean) : fallbackScopes,
    };
  }

  private async tokenRequest(form: Record<string, string>) {
    const r = await this.request<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    }>('POST', this.ep.token, {
      form: { client_id: this.opts.clientId, client_secret: this.opts.clientSecret, ...form },
      auth: false,
      oauth: true,
    });
    return r;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    o: {
      credentials?: ProviderCredentials;
      json?: unknown;
      form?: Record<string, string>;
      auth?: boolean;
      /** Escritura externa: un fallo de red o 5xx deja el resultado en duda. */
      write?: boolean;
      oauth?: boolean;
    },
  ): Promise<Result<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (o.auth !== false && o.credentials)
      headers.authorization = `Bearer ${o.credentials.accessToken}`;
    let body: string | undefined;
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(o.form).toString();
    }
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      const name = (err as Error).name;
      return fail(
        o.write
          ? {
              kind: 'ambiguous',
              message: `Sin respuesta de Google (${name}); se consultará el estado antes de reintentar`,
              retryable: true,
            }
          : {
              kind: 'transient',
              message: `No se pudo contactar con Google (${name})`,
              retryable: true,
            },
      );
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return ok(data as T);
    return fail(mapGoogleError(res, data, Boolean(o.write), Boolean(o.oauth)));
  }
}

/** Traduce errores HTTP de Google. Nunca incluye tokens: solo el mensaje del proveedor, recortado. */
export function mapGoogleError(
  res: Pick<Response, 'status' | 'headers'>,
  data: Record<string, unknown>,
  write: boolean,
  oauth: boolean,
): ConnectorError {
  const err = (data.error ?? {}) as { message?: string; status?: string } | string;
  const code = typeof err === 'string' ? err : err.status;
  const raw =
    typeof err === 'string'
      ? String(data.error_description ?? err)
      : (err.message ?? `HTTP ${res.status}`);
  const message = raw.replace(/ya29\.[\w.-]+|1\/\/[\w.-]+/g, '[token]').slice(0, 300);
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  if (oauth && (code === 'invalid_grant' || code === 'unauthorized_client')) {
    return {
      kind: 'credentials_expired',
      message: 'Google ha revocado o caducado la autorización; vuelve a conectar la cuenta',
      providerCode: code,
      retryable: false,
    };
  }
  if (res.status === 401)
    return { kind: 'credentials_expired', message, providerCode: code, retryable: false };
  if (res.status === 403)
    return { kind: 'insufficient_permissions', message, providerCode: code, retryable: false };
  if (res.status === 404)
    return { kind: 'not_found', message, providerCode: code, retryable: false };
  if (res.status === 429)
    return {
      kind: 'rate_limited',
      message,
      providerCode: code,
      retryAfterSec: retryAfter,
      retryable: true,
    };
  if (res.status >= 500)
    return write
      ? {
          kind: 'ambiguous',
          message: `Google respondió ${res.status}; se consultará el estado antes de reintentar`,
          providerCode: code,
          retryable: true,
        }
      : {
          kind: 'transient',
          message,
          providerCode: code,
          retryAfterSec: retryAfter,
          retryable: true,
        };
  return { kind: 'invalid_request', message, providerCode: code, retryable: false };
}
