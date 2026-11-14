/**
 * Conectores de Meta: páginas de Facebook y cuentas profesionales de Instagram
 * vinculadas a una página. Una sola app de Meta y un solo inicio de sesión
 * (Facebook Login) dan acceso a ambas.
 *
 * Referencia verificada el 14/11/2026 en developers.facebook.com (Graph API v26.0):
 *  - Diálogo:        https://www.facebook.com/v26.0/dialog/oauth?client_id&redirect_uri&state&scope&response_type=code
 *  - Canje:          GET /oauth/access_token?client_id&redirect_uri&client_secret&code
 *  - Token largo:    GET /oauth/access_token?grant_type=fb_exchange_token&… (≈60 días)
 *  - Páginas:        GET /me/accounts → token de página (sin caducidad fija) + tasks + IG vinculada
 *  - Permisos:       GET /me/permissions · revocar: DELETE /me/permissions
 *  - FB comentarios: GET /{post-id}/comments (filter=toplevel) · responder POST /{comment-id}/comments
 *  - IG comentarios: GET /{media-id}/comments (máx. 50) · responder POST /{comment-id}/replies
 *  - Webhooks:       verificación GET hub.* y firma X-Hub-Signature-256 (HMAC-SHA256 del cuerpo)
 *
 * Todas las llamadas con token añaden appsecret_proof. Sin app aprobada por
 * Meta (App Review) solo funcionan las cuentas con rol en la app: el conector
 * informa del error real y nunca simula éxito.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  fail,
  ok,
  type Capability,
  type CapabilitySet,
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
  type WebhookEvent,
  type WebhookRequest,
} from './contract';
import { contentHash, normalizeText } from './hash';

export const META_GRAPH_VERSION = 'v26.0';

/** Permisos que se piden en el inicio de sesión. Sin los obligatorios no se conecta nada. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_manage_comments',
] as const;

export const FACEBOOK_REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
];
export const FACEBOOK_REPLY_SCOPE = 'pages_manage_engagement';
export const INSTAGRAM_REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_comments',
];

export interface MetaEndpoints {
  dialog: string;
  graph: string;
}

export const metaEndpoints = (version = META_GRAPH_VERSION): MetaEndpoints => ({
  dialog: `https://www.facebook.com/${version}/dialog/oauth`,
  graph: `https://graph.facebook.com/${version}`,
});

export interface MetaOptions {
  appId: string;
  appSecret: string;
  graphVersion?: string;
  endpoints?: Partial<MetaEndpoints>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Publicaciones recientes que se revisan en cada sincronización. */
  postsPerSync?: number;
}

/** Página de Facebook que el usuario gestiona, con su token (solo en memoria del backend). */
export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  instagram?: { id: string; username?: string };
}

export interface MetaUser {
  id: string;
  name?: string;
}

type Method = 'GET' | 'POST' | 'DELETE';

interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/** Cliente HTTP mínimo de la Graph API con appsecret_proof y mapeo de errores. */
export class MetaGraph {
  readonly ep: MetaEndpoints;
  private f: typeof fetch;

  constructor(private opts: MetaOptions) {
    this.ep = { ...metaEndpoints(opts.graphVersion), ...opts.endpoints };
    this.f = opts.fetch ?? fetch;
  }

  get appId() {
    return this.opts.appId;
  }
  get postsPerSync() {
    return Math.min(Math.max(this.opts.postsPerSync ?? 25, 1), 50);
  }

  proof(token: string) {
    return createHmac('sha256', this.opts.appSecret).update(token).digest('hex');
  }

  /** URL del diálogo de Facebook Login. Meta no documenta PKCE para este flujo: se protege con `state`. */
  authorizationUrl(redirectUri: string, state: string, scopes: readonly string[] = META_SCOPES) {
    const u = new URL(this.ep.dialog);
    u.search = new URLSearchParams({
      client_id: this.opts.appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: scopes.join(','),
      // Vuelve a pedir los permisos que se rechazaron en un intento anterior.
      auth_type: 'rerequest',
    }).toString();
    return u.toString();
  }

  /** Canjea el código y lo convierte en un token de usuario de larga duración. */
  async exchangeCode(code: string, redirectUri: string): Promise<Result<ProviderCredentials>> {
    const short = await this.call<{ access_token: string }>('GET', '/oauth/access_token', {
      query: {
        client_id: this.opts.appId,
        client_secret: this.opts.appSecret,
        redirect_uri: redirectUri,
        code,
      },
      oauth: true,
    });
    if (!short.ok) return fail(short.error);
    const long = await this.call<{ access_token: string; expires_in?: number }>(
      'GET',
      '/oauth/access_token',
      {
        query: {
          grant_type: 'fb_exchange_token',
          client_id: this.opts.appId,
          client_secret: this.opts.appSecret,
          fb_exchange_token: short.value.access_token,
        },
        oauth: true,
      },
    );
    if (!long.ok) return fail(long.error);
    const token = long.value.access_token;
    const perms = await this.grantedPermissions(token);
    if (!perms.ok) return fail(perms.error);
    const me = await this.call<MetaUser>('GET', '/me', { token, query: { fields: 'id,name' } });
    if (!me.ok) return fail(me.error);
    return ok({
      accessToken: token,
      expiresAt: long.value.expires_in
        ? new Date(Date.now() + long.value.expires_in * 1000)
        : undefined,
      scopes: perms.value,
      meta: { userId: me.value.id },
    });
  }

  async grantedPermissions(token: string): Promise<Result<string[]>> {
    const r = await this.call<{ data?: { permission: string; status: string }[] }>(
      'GET',
      '/me/permissions',
      { token },
    );
    if (!r.ok) return fail(r.error);
    return ok((r.value.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission));
  }

  /** Páginas que gestiona el usuario, con su token de página y la cuenta de Instagram vinculada. */
  async listPages(userToken: string): Promise<Result<MetaPage[]>> {
    const out: MetaPage[] = [];
    let after: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await this.call<{
        data?: {
          id: string;
          name?: string;
          access_token?: string;
          tasks?: string[];
          instagram_business_account?: { id: string; username?: string };
        }[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', '/me/accounts', {
        token: userToken,
        query: {
          fields: 'id,name,access_token,tasks,instagram_business_account{id,username}',
          limit: '50',
          ...(after ? { after } : {}),
        },
      });
      if (!r.ok) return fail(r.error);
      for (const p of r.value.data ?? []) {
        if (!p.access_token) continue; // sin token de página no se puede operar con ella
        out.push({
          id: p.id,
          name: p.name ?? p.id,
          accessToken: p.access_token,
          tasks: p.tasks ?? [],
          instagram: p.instagram_business_account,
        });
      }
      after = r.value.paging?.next ? r.value.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return ok(out);
  }

  /** Revoca la autorización completa de la app para este usuario de Facebook. */
  async revoke(userToken: string): Promise<Result<void>> {
    const r = await this.call<{ success?: boolean }>('DELETE', '/me/permissions', {
      token: userToken,
    });
    if (!r.ok && r.error.kind !== 'credentials_expired') return fail(r.error);
    return ok(undefined);
  }

  /** Suscribe la página a los avisos de comentarios (webhooks). Requiere pages_manage_metadata. */
  async subscribePage(page: { id: string; accessToken: string }): Promise<Result<void>> {
    const r = await this.call<{ success?: boolean }>('POST', `/${page.id}/subscribed_apps`, {
      token: page.accessToken,
      query: { subscribed_fields: 'feed' },
    });
    return r.ok ? ok(undefined) : fail(r.error);
  }

  async unsubscribePage(page: { id: string; accessToken: string }): Promise<Result<void>> {
    const r = await this.call<{ success?: boolean }>('DELETE', `/${page.id}/subscribed_apps`, {
      token: page.accessToken,
    });
    return r.ok || r.error.kind === 'credentials_expired' ? ok(undefined) : fail(r.error);
  }

  async call<T>(
    method: Method,
    path: string,
    o: {
      token?: string;
      query?: Record<string, string>;
      form?: Record<string, string>;
      write?: boolean;
      oauth?: boolean;
    } = {},
  ): Promise<Result<T>> {
    const u = new URL(path.startsWith('http') ? path : `${this.ep.graph}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) u.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (o.token) {
      // El token va en la cabecera (no en la URL) para que no aparezca en registros intermedios.
      headers.authorization = `Bearer ${o.token}`;
      u.searchParams.set('appsecret_proof', this.proof(o.token));
    }
    if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(o.form).toString();
    }
    let res: Response;
    try {
      res = await this.f(u.toString(), {
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
              message: `Sin respuesta de Meta (${name}); se consultará el estado antes de reintentar`,
              retryable: true,
            }
          : {
              kind: 'transient',
              message: `No se pudo contactar con Meta (${name})`,
              retryable: true,
            },
      );
    }
    const data = (await res.json().catch(() => ({}))) as { error?: GraphError } & Record<
      string,
      unknown
    >;
    if (res.ok && !data.error) return ok(data as T);
    return fail(mapMetaError(res, data.error ?? {}, Boolean(o.write), Boolean(o.oauth)));
  }
}

/**
 * Traduce errores de la Graph API (https://developers.facebook.com/docs/graph-api/guides/error-handling).
 * Nunca incluye tokens en el mensaje.
 */
export function mapMetaError(
  res: Pick<Response, 'status' | 'headers'>,
  e: GraphError,
  write: boolean,
  oauth: boolean,
): ConnectorError {
  const code = e.code;
  const providerCode =
    code != null ? `${code}${e.error_subcode ? `/${e.error_subcode}` : ''}` : undefined;
  const message = (e.message ?? `HTTP ${res.status}`)
    .replace(/EAA[\w-]+/g, '[token]')
    .slice(0, 300);
  const base = { message, providerCode };
  if (code === 190 || code === 102 || code === 463 || code === 467) {
    return {
      ...base,
      kind: 'credentials_expired',
      message: `Meta ha caducado o revocado la autorización; vuelve a conectar (${message})`,
      retryable: false,
    };
  }
  if (oauth && (code === 100 || code === 101 || res.status === 400)) {
    return { ...base, kind: 'invalid_request', retryable: false };
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code ?? 0) >= 80000) {
    return { ...base, kind: 'rate_limited', retryAfterSec: 600, retryable: true };
  }
  if (code === 10 || code === 3 || (code != null && code >= 200 && code <= 299)) {
    return { ...base, kind: 'insufficient_permissions', retryable: false };
  }
  if (code === 100 && e.error_subcode === 33)
    return { ...base, kind: 'not_found', retryable: false };
  if (code === 368) {
    return {
      ...base,
      kind: 'provider_error',
      message: `Meta bloqueó la acción: ${message}`,
      retryable: false,
    };
  }
  if (code === 1 || code === 2 || res.status >= 500) {
    return write
      ? {
          ...base,
          kind: 'ambiguous',
          message: `Meta respondió con un error temporal (${message}); se consultará el estado antes de reintentar`,
          retryable: true,
        }
      : { ...base, kind: 'transient', retryable: true };
  }
  if (res.status === 404) return { ...base, kind: 'not_found', retryable: false };
  if (res.status === 401) return { ...base, kind: 'credentials_expired', retryable: false };
  if (res.status === 403) return { ...base, kind: 'insufficient_permissions', retryable: false };
  return { ...base, kind: 'invalid_request', retryable: false };
}

// ---------------------------------------------------------------- Webhooks

/** Comprueba X-Hub-Signature-256 = sha256=HMAC(app secret, cuerpo sin modificar). */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const got = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', appSecret).update(rawBody).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Respuesta a la verificación de la suscripción (GET). Devuelve el challenge o null. */
export function metaWebhookChallenge(
  query: Record<string, string | undefined>,
  verifyToken: string,
): string | null {
  if (query['hub.mode'] !== 'subscribe') return null;
  const got = Buffer.from(query['hub.verify_token'] ?? '');
  const want = Buffer.from(verifyToken);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const c = query['hub.challenge'] ?? '';
  return /^[\w-]{1,200}$/.test(c) ? c : null;
}

interface WebhookBody {
  object?: string;
  entry?: {
    id?: string;
    time?: number;
    changes?: { field?: string; value?: Record<string, unknown> }[];
  }[];
}

/**
 * Normaliza un aviso ya autenticado. Solo se usan los identificadores: el
 * contenido se vuelve a leer de la API en la sincronización.
 */
export function parseMetaWebhook(rawBody: Buffer): Result<WebhookEvent[]> {
  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as WebhookBody;
  } catch {
    return fail({ kind: 'invalid_request', message: 'Cuerpo JSON no válido', retryable: false });
  }
  const provider =
    body.object === 'page'
      ? ('facebook_page' as const)
      : body.object === 'instagram'
        ? ('instagram_business' as const)
        : null;
  if (!provider) return ok([]);
  const out: WebhookEvent[] = [];
  for (const entry of (body.entry ?? []).slice(0, 1000)) {
    if (!entry.id || !/^\d{1,40}$/.test(entry.id)) continue;
    for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      let interactionId: string | undefined;
      let type: WebhookEvent['type'] = 'other';
      if (provider === 'facebook_page' && ch.field === 'feed' && v.item === 'comment') {
        interactionId = typeof v.comment_id === 'string' ? v.comment_id : undefined;
        type =
          v.verb === 'add'
            ? 'interaction_created'
            : v.verb === 'edited'
              ? 'interaction_updated'
              : v.verb === 'remove'
                ? 'interaction_deleted'
                : 'other';
      } else if (provider === 'instagram_business' && ch.field === 'comments') {
        interactionId = typeof v.id === 'string' ? v.id : undefined;
        type = 'interaction_created';
      } else {
        continue;
      }
      // Meta reintenta durante horas: el id se deriva del contenido para deduplicar.
      const eventId = createHash('sha256')
        .update(
          [
            provider,
            entry.id,
            ch.field,
            interactionId ?? '',
            String(v.verb ?? ''),
            String(entry.time ?? ''),
          ].join('|'),
        )
        .digest('hex');
      out.push({
        provider,
        eventId,
        accountExternalId: entry.id,
        interactionExternalId: interactionId,
        type,
        receivedAt: new Date(),
      });
    }
  }
  return ok(out);
}

// ------------------------------------------------------- Conector común

const SUPPORTED: Capability[] = [
  'oauth_connect',
  'list_accounts',
  'fetch_interactions',
  'fetch_interaction',
  'read_existing_replies',
  'publish_reply',
  'publication_status',
  'webhooks',
];

/** Cursor de sincronización: publicaciones pendientes de revisar en esta pasada. */
interface SyncCursor {
  posts: string[];
}
const encodeCursor = (c: SyncCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string | undefined): SyncCursor | null {
  if (!s) return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as SyncCursor;
    return Array.isArray(c.posts) && c.posts.every((p) => typeof p === 'string') ? c : null;
  } catch {
    return null;
  }
}

const ID = /^[\d_]{1,80}$/;
const badId = (what: string) =>
  fail({
    kind: 'invalid_request' as const,
    message: `Identificador de ${what} no válido`,
    retryable: false,
  });

abstract class MetaConnectorBase implements ProviderConnector {
  abstract readonly provider: 'facebook_page' | 'instagram_business';
  protected abstract required: string[];
  protected abstract replyScopes: string[];
  readonly graph: MetaGraph;
  private appSecret: string;

  constructor(opts: MetaOptions) {
    this.graph = new MetaGraph(opts);
    this.appSecret = opts.appSecret;
  }

  async getCapabilities(credentials?: ProviderCredentials): Promise<CapabilitySet> {
    const supported = new Set(SUPPORTED);
    let granted: Set<Capability> | undefined;
    if (credentials) {
      const has = (s: string[]) => s.every((x) => credentials.scopes.includes(x));
      granted = has(this.required) ? new Set(supported) : new Set();
      if (!has(this.replyScopes)) granted.delete('publish_reply');
    }
    return { provider: this.provider, supported, granted, notes: this.notes() };
  }

  protected abstract notes(): string[];

  async connect(params: { redirectUri: string; state: string }): Promise<Result<OAuthStart>> {
    return ok({
      authorizationUrl: this.graph.authorizationUrl(params.redirectUri, params.state),
      state: params.state,
    });
  }

  completeConnect(params: {
    code: string;
    redirectUri: string;
  }): Promise<Result<ProviderCredentials>> {
    return this.graph.exchangeCode(params.code, params.redirectUri);
  }

  /**
   * Revoca la app para el usuario de Facebook (credenciales de usuario, no de página).
   * Afecta a todas sus páginas: el servicio decide cuándo llamarlo.
   */
  async disconnect(c: ProviderCredentials): Promise<Result<void>> {
    return this.graph.revoke(c.accessToken);
  }

  async validateCredentials(c: ProviderCredentials): Promise<Result<{ grantedScopes: string[] }>> {
    const r = await this.graph.grantedPermissions(c.accessToken);
    return r.ok ? ok({ grantedScopes: r.value }) : fail(r.error);
  }

  /** Los tokens de página no caducan por tiempo; si Meta los invalida hay que volver a conectar. */
  async refreshCredentials(c: ProviderCredentials): Promise<Result<ProviderCredentials>> {
    return ok(c);
  }

  async listAccounts(c: ProviderCredentials): Promise<Result<ExternalAccount[]>> {
    const pages = await this.graph.listPages(c.accessToken);
    if (!pages.ok) return fail(pages.error);
    return ok(this.accountsFrom(pages.value));
  }

  protected abstract accountsFrom(pages: MetaPage[]): ExternalAccount[];

  async listLocations(): Promise<Result<ExternalLocation[]>> {
    return ok([]); // Meta no tiene ubicaciones: cada página o cuenta es una fuente.
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
    const missing = this.required.filter((s) => !v.value.grantedScopes.includes(s));
    return missing.length
      ? {
          status: 'insufficient_access',
          checkedAt: new Date(),
          detail: `Faltan permisos: ${missing.join(', ')}`,
        }
      : { status: 'connected', checkedAt: new Date() };
  }

  /** Los avisos de Meta se autentican y normalizan en la ruta del webhook (verifyMetaSignature). */
  async handleWebhook(req: WebhookRequest): Promise<Result<WebhookEvent[]>> {
    const sig = req.headers['x-hub-signature-256'];
    if (!verifyMetaSignature(req.rawBody, sig, this.appSecret)) {
      return fail({
        kind: 'not_authorized',
        message: 'Firma del webhook no válida',
        retryable: false,
      });
    }
    const r = parseMetaWebhook(req.rawBody);
    if (!r.ok) return r;
    return ok(r.value.filter((e) => e.provider === this.provider));
  }

  abstract fetchInteractions(p: FetchParams): Promise<Result<FetchPage>>;
  abstract fetchInteraction(
    p: FetchParams & { interactionExternalId: string },
  ): Promise<Result<NormalizedInteraction>>;
  abstract publishReply(p: PublishParams): Promise<Result<PublicationReceipt>>;
  abstract getPublicationStatus(
    p: Omit<PublishParams, 'content'> & { expectedContent: string },
  ): Promise<Result<PublicationReceipt>>;

  /** Busca la respuesta propia con el texto esperado entre las respuestas del comentario. */
  protected receiptFor(
    replies: { id: string; text?: string; fromId?: string }[],
    ownId: string,
    expected: string,
  ): PublicationReceipt {
    const want = normalizeText(expected);
    const own = replies.filter((r) => r.fromId === ownId);
    const same = own.find((r) => normalizeText(r.text) === want);
    if (same) {
      return {
        status: 'published',
        externalReplyId: same.id,
        publishedContent: same.text,
        observedAt: new Date(),
        providerState: 'visible',
      };
    }
    return { status: 'not_found', observedAt: new Date() };
  }
}

// ------------------------------------------------------------ Facebook

interface FbComment {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name?: string };
  permalink_url?: string;
  can_comment?: boolean;
  is_hidden?: boolean;
  comments?: { data?: FbComment[] };
}

const FB_COMMENT_FIELDS =
  'id,message,created_time,from{id,name},permalink_url,can_comment,is_hidden,comments.limit(25){id,message,created_time,from{id,name}}';

export class FacebookPageConnector extends MetaConnectorBase {
  readonly provider = 'facebook_page' as const;
  protected required = FACEBOOK_REQUIRED_SCOPES;
  protected replyScopes = [FACEBOOK_REPLY_SCOPE];

  protected notes() {
    return [
      'Comentarios de primer nivel en las publicaciones recientes de la página.',
      'Las respuestas entre usuarios dentro de un hilo no se importan todavía.',
      'Responder requiere pages_manage_engagement y el rol de moderación en la página.',
    ];
  }

  protected accountsFrom(pages: MetaPage[]): ExternalAccount[] {
    return pages.map((p) => ({ externalId: p.id, displayName: p.name, type: 'facebook_page' }));
  }

  async fetchInteractions(p: FetchParams): Promise<Result<FetchPage>> {
    const pageId = p.accountExternalId;
    if (!ID.test(pageId)) return badId('página');
    let cursor = decodeCursor(p.cursor);
    if (!cursor) {
      const posts = await this.graph.call<{ data?: { id: string }[] }>('GET', `/${pageId}/feed`, {
        token: p.credentials.accessToken,
        query: { fields: 'id', limit: String(this.graph.postsPerSync) },
      });
      if (!posts.ok) return fail(posts.error);
      cursor = { posts: (posts.value.data ?? []).map((x) => x.id).filter((x) => ID.test(x)) };
    }
    const [postId, ...rest] = cursor.posts;
    if (!postId) return ok({ items: [], complete: true });
    const items: NormalizedInteraction[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await this.graph.call<{
        data?: FbComment[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', `/${postId}/comments`, {
        token: p.credentials.accessToken,
        query: {
          filter: 'toplevel',
          order: 'reverse_chronological',
          fields: FB_COMMENT_FIELDS,
          limit: '100',
          ...(after ? { after } : {}),
        },
      });
      if (!r.ok) {
        // Una publicación borrada entre la lista y la lectura no detiene la sincronización.
        if (r.error.kind === 'not_found') break;
        return fail(r.error);
      }
      for (const c of r.value.data ?? []) {
        if (c.from?.id === pageId) continue; // comentarios de la propia página
        items.push(this.normalize(c, pageId, postId));
      }
      after = r.value.paging?.next ? r.value.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return ok({
      items,
      nextCursor: rest.length ? encodeCursor({ posts: rest }) : undefined,
      complete: true,
    });
  }

  async fetchInteraction(
    p: FetchParams & { interactionExternalId: string },
  ): Promise<Result<NormalizedInteraction>> {
    if (!ID.test(p.interactionExternalId)) return badId('comentario');
    const r = await this.graph.call<FbComment & { parent?: { id: string } }>(
      'GET',
      `/${p.interactionExternalId}`,
      { token: p.credentials.accessToken, query: { fields: FB_COMMENT_FIELDS } },
    );
    if (!r.ok) return fail(r.error);
    return ok(this.normalize(r.value, p.accountExternalId, undefined));
  }

  private normalize(
    c: FbComment,
    pageId: string,
    postId: string | undefined,
  ): NormalizedInteraction {
    const content = c.message?.trim() ? c.message : null;
    const own = (c.comments?.data ?? [])
      .filter((x) => x.from?.id === pageId && x.message)
      .sort((a, b) => b.created_time.localeCompare(a.created_time))[0];
    return {
      provider: this.provider,
      kind: 'comment',
      externalId: c.id,
      externalParentId: postId,
      authorName: c.from?.name,
      authorExternalId: c.from?.id,
      content,
      url: c.permalink_url,
      createdAt: new Date(c.created_time),
      existingReply: own
        ? { content: own.message!, updatedAt: new Date(own.created_time), externalId: own.id }
        : undefined,
      contentHash: contentHash(content),
      raw: { canComment: c.can_comment ?? null, isHidden: c.is_hidden ?? null },
    };
  }

  async publishReply(p: PublishParams): Promise<Result<PublicationReceipt>> {
    if (!ID.test(p.interactionExternalId)) return badId('comentario');
    const r = await this.graph.call<{ id?: string }>(
      'POST',
      `/${p.interactionExternalId}/comments`,
      {
        token: p.credentials.accessToken,
        form: { message: p.content },
        write: true,
      },
    );
    if (!r.ok) return fail(r.error);
    return ok({
      status: 'published',
      externalReplyId: r.value.id,
      publishedContent: p.content,
      observedAt: new Date(),
      providerState: 'visible',
    });
  }

  async getPublicationStatus(
    p: Omit<PublishParams, 'content'> & { expectedContent: string },
  ): Promise<Result<PublicationReceipt>> {
    if (!ID.test(p.interactionExternalId)) return badId('comentario');
    const replies: { id: string; text?: string; fromId?: string }[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await this.graph.call<{
        data?: FbComment[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', `/${p.interactionExternalId}/comments`, {
        token: p.credentials.accessToken,
        query: { fields: 'id,message,from{id}', limit: '100', ...(after ? { after } : {}) },
      });
      if (!r.ok) return fail(r.error);
      for (const c of r.value.data ?? [])
        replies.push({ id: c.id, text: c.message, fromId: c.from?.id });
      after = r.value.paging?.next ? r.value.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return ok(this.receiptFor(replies, p.accountExternalId, p.expectedContent));
  }
}

// ----------------------------------------------------------- Instagram

interface IgComment {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  from?: { id: string; username?: string };
  hidden?: boolean;
  replies?: { data?: IgComment[] };
}

const IG_COMMENT_FIELDS =
  'id,text,timestamp,username,from{id,username},hidden,replies{id,text,timestamp,username,from{id,username}}';

export class InstagramBusinessConnector extends MetaConnectorBase {
  readonly provider = 'instagram_business' as const;
  protected required = INSTAGRAM_REQUIRED_SCOPES;
  protected replyScopes = ['instagram_manage_comments'];

  protected notes() {
    return [
      'Comentarios de primer nivel en las publicaciones recientes de la cuenta profesional.',
      'Instagram solo permite responder a comentarios de primer nivel, no ocultos y fuera de directos.',
      'Las menciones (@cuenta) no se importan todavía.',
    ];
  }

  protected accountsFrom(pages: MetaPage[]): ExternalAccount[] {
    return pages
      .filter((p) => p.instagram)
      .map((p) => ({
        externalId: p.instagram!.id,
        displayName: p.instagram!.username ? `@${p.instagram!.username}` : p.name,
        type: 'instagram_business',
      }));
  }

  async fetchInteractions(p: FetchParams): Promise<Result<FetchPage>> {
    const igId = p.accountExternalId;
    if (!ID.test(igId)) return badId('cuenta de Instagram');
    let cursor = decodeCursor(p.cursor);
    if (!cursor) {
      const media = await this.graph.call<{ data?: { id: string }[] }>('GET', `/${igId}/media`, {
        token: p.credentials.accessToken,
        query: { fields: 'id', limit: String(this.graph.postsPerSync) },
      });
      if (!media.ok) return fail(media.error);
      cursor = { posts: (media.value.data ?? []).map((x) => x.id).filter((x) => ID.test(x)) };
    }
    const [mediaId, ...rest] = cursor.posts;
    if (!mediaId) return ok({ items: [], complete: true });
    const items: NormalizedInteraction[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await this.graph.call<{
        data?: IgComment[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', `/${mediaId}/comments`, {
        token: p.credentials.accessToken,
        query: { fields: IG_COMMENT_FIELDS, limit: '50', ...(after ? { after } : {}) },
      });
      if (!r.ok) {
        if (r.error.kind === 'not_found') break;
        return fail(r.error);
      }
      for (const c of r.value.data ?? []) {
        if (c.from?.id === igId) continue;
        items.push(this.normalize(c, igId, mediaId));
      }
      after = r.value.paging?.next ? r.value.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return ok({
      items,
      nextCursor: rest.length ? encodeCursor({ posts: rest }) : undefined,
      complete: true,
    });
  }

  async fetchInteraction(
    p: FetchParams & { interactionExternalId: string },
  ): Promise<Result<NormalizedInteraction>> {
    if (!ID.test(p.interactionExternalId)) return badId('comentario');
    const r = await this.graph.call<IgComment & { media?: { id: string } }>(
      'GET',
      `/${p.interactionExternalId}`,
      { token: p.credentials.accessToken, query: { fields: `${IG_COMMENT_FIELDS},media{id}` } },
    );
    if (!r.ok) return fail(r.error);
    return ok(this.normalize(r.value, p.accountExternalId, r.value.media?.id));
  }

  private normalize(
    c: IgComment,
    igId: string,
    mediaId: string | undefined,
  ): NormalizedInteraction {
    const content = c.text?.trim() ? c.text : null;
    const own = (c.replies?.data ?? [])
      .filter((x) => x.from?.id === igId && x.text)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    const username = c.from?.username ?? c.username;
    return {
      provider: this.provider,
      kind: 'comment',
      externalId: c.id,
      externalParentId: mediaId,
      authorName: username ? `@${username}` : undefined,
      authorExternalId: c.from?.id,
      content,
      createdAt: new Date(c.timestamp),
      existingReply: own
        ? { content: own.text!, updatedAt: new Date(own.timestamp), externalId: own.id }
        : undefined,
      contentHash: contentHash(content),
      raw: { hidden: c.hidden ?? null },
    };
  }

  async publishReply(p: PublishParams): Promise<Result<PublicationReceipt>> {
    if (!ID.test(p.interactionExternalId)) return badId('comentario');
    const r = await this.graph.call<{ id?: string }>(
      'POST',
      `/${p.interactionExternalId}/replies`,
      {
        token: p.credentials.accessToken,
        form: { message: p.content },
        write: true,
      },
    );
    if (!r.ok) return fail(r.error);
    return ok({
      status: 'published',
      externalReplyId: r.value.id,
      publishedContent: p.content,
      observedAt: new Date(),
      providerState: 'visible',
    });
  }

  async getPublicationStatus(
    p: Omit<PublishParams, 'content'> & { expectedContent: string },
  ): Promise<Result<PublicationReceipt>> {
    if (!ID.test(p.interactionExternalId)) return badId('comentario');
    const replies: { id: string; text?: string; fromId?: string }[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await this.graph.call<{
        data?: IgComment[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>('GET', `/${p.interactionExternalId}/replies`, {
        token: p.credentials.accessToken,
        query: { fields: 'id,text,from{id}', limit: '50', ...(after ? { after } : {}) },
      });
      if (!r.ok) return fail(r.error);
      for (const c of r.value.data ?? [])
        replies.push({ id: c.id, text: c.text, fromId: c.from?.id });
      after = r.value.paging?.next ? r.value.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return ok(this.receiptFor(replies, p.accountExternalId, p.expectedContent));
  }
}
