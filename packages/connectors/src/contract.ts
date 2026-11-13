/**
 * Contrato común de conectores de proveedor.
 *
 * Reglas:
 *  - Cada conector declara las capacidades REALMENTE disponibles (getCapabilities).
 *  - Una operación no soportada devuelve { ok: false, error.kind: 'not_supported' };
 *    nunca simula éxito.
 *  - Los conectores no conocen tenants, RLS ni la base de datos: reciben credenciales
 *    ya descifradas por el servicio Connected Accounts (solo en backend/worker) y
 *    devuelven datos normalizados. La UI nunca consume formatos de Google/Meta.
 *  - Toda escritura externa (publishReply) exige una idempotencyKey y debe poder
 *    consultarse después con getPublicationStatus para evitar duplicados.
 */

export type ProviderId =
  | 'google_business_profile'
  | 'facebook_page'
  | 'instagram_business'
  | 'web_search'
  | 'rss'
  | 'simulator';

export type InteractionKind = 'review' | 'comment' | 'reply' | 'mention' | 'web_mention';

export type Capability =
  | 'oauth_connect'
  | 'list_accounts'
  | 'list_locations'
  | 'fetch_interactions'
  | 'fetch_interaction'
  | 'read_existing_replies'
  | 'publish_reply'
  | 'update_reply'
  | 'delete_reply'
  | 'publication_status'
  | 'webhooks'
  | 'mentions';

export interface CapabilitySet {
  provider: ProviderId;
  /** Capacidades soportadas por el proveedor (independiente de permisos concedidos). */
  supported: ReadonlySet<Capability>;
  /** Capacidades efectivas para una cuenta concreta según scopes/permisos concedidos. */
  granted?: ReadonlySet<Capability>;
  notes?: string[];
}

export type ConnectorErrorKind =
  | 'not_supported'
  | 'not_authorized'
  | 'credentials_expired'
  | 'insufficient_permissions'
  | 'rate_limited'
  | 'transient'
  | 'not_found'
  | 'invalid_request'
  | 'ambiguous'
  | 'provider_error';

export interface ConnectorError {
  kind: ConnectorErrorKind;
  message: string;
  /** Segundos sugeridos por el proveedor antes de reintentar (Retry-After, etc). */
  retryAfterSec?: number;
  retryable: boolean;
  /** Código del proveedor, saneado: nunca contiene tokens. */
  providerCode?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ConnectorError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: ConnectorError): Result<T> => ({ ok: false, error });
export const notSupported = <T = never>(provider: ProviderId, op: string): Result<T> =>
  fail({ kind: 'not_supported', message: `${provider} no soporta ${op}`, retryable: false });

/** Credenciales descifradas. Solo existen en memoria del backend/worker. */
export interface ProviderCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  /** Datos adicionales del proveedor (p.ej. page id). Sin secretos. */
  meta?: Record<string, string>;
}

export interface ExternalAccount {
  externalId: string;
  displayName: string;
  type: string;
}

export interface ExternalLocation {
  externalId: string;
  accountExternalId: string;
  displayName: string;
  address?: string;
  /** p.ej. GBP: perfil verificado y apto para responder reseñas. */
  canReply: boolean;
  ineligibilityReason?: string;
}

/** Interacción normalizada, independiente del proveedor. */
export interface NormalizedInteraction {
  provider: ProviderId;
  kind: InteractionKind;
  externalId: string;
  externalParentId?: string;
  externalLocationId?: string;
  authorName?: string;
  /** Identificador del autor en el proveedor; se almacena seudonimizado. */
  authorExternalId?: string;
  content: string | null;
  language?: string;
  rating?: number;
  ratingScale?: number;
  url?: string;
  createdAt: Date;
  updatedAt?: Date;
  existingReply?: { content: string; updatedAt?: Date; externalId?: string };
  /** Hash del contenido normalizado para detectar ediciones. */
  contentHash: string;
  /** Solo campos permitidos del payload original, para trazabilidad. */
  raw?: Record<string, unknown>;
}

export interface FetchPage {
  items: NormalizedInteraction[];
  nextCursor?: string;
  /** El proveedor confirmó la consulta aunque no haya novedades. */
  complete: boolean;
}

export interface FetchParams {
  credentials: ProviderCredentials;
  accountExternalId: string;
  locationExternalId?: string;
  since?: Date;
  cursor?: string;
  pageSize?: number;
}

export interface PublishParams {
  credentials: ProviderCredentials;
  accountExternalId: string;
  locationExternalId?: string;
  interactionExternalId: string;
  content: string;
  /** Clave idempotente = id del publication_job. */
  idempotencyKey: string;
}

export interface PublicationReceipt {
  status: 'published' | 'pending' | 'not_found' | 'rejected';
  externalReplyId?: string;
  publishedContent?: string;
  observedAt: Date;
  providerState?: string;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
  query: Record<string, string | undefined>;
}

export interface WebhookEvent {
  provider: ProviderId;
  /** Id único del evento para deduplicación. */
  eventId: string;
  accountExternalId: string;
  interactionExternalId?: string;
  type: 'interaction_created' | 'interaction_updated' | 'interaction_deleted' | 'other';
  receivedAt: Date;
}

export type HealthStatus =
  | 'connected'
  | 'pending_authorization'
  | 'syncing'
  | 'insufficient_access'
  | 'credentials_expired'
  | 'temporary_error'
  | 'disconnected';

export interface ConnectorHealth {
  status: HealthStatus;
  checkedAt: Date;
  detail?: string;
}

export interface OAuthStart {
  authorizationUrl: string;
  /** state firmado + PKCE verifier se guardan en servidor, no en el cliente. */
  state: string;
  codeVerifier?: string;
}

export interface ProviderConnector {
  readonly provider: ProviderId;
  getCapabilities(credentials?: ProviderCredentials): Promise<CapabilitySet>;

  connect(params: { redirectUri: string; state: string }): Promise<Result<OAuthStart>>;
  completeConnect(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<Result<ProviderCredentials>>;
  disconnect(credentials: ProviderCredentials): Promise<Result<void>>;
  validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<Result<{ grantedScopes: string[] }>>;
  refreshCredentials(credentials: ProviderCredentials): Promise<Result<ProviderCredentials>>;

  listAccounts(credentials: ProviderCredentials): Promise<Result<ExternalAccount[]>>;
  listLocations(
    credentials: ProviderCredentials,
    accountExternalId: string,
  ): Promise<Result<ExternalLocation[]>>;

  fetchInteractions(params: FetchParams): Promise<Result<FetchPage>>;
  fetchInteraction(
    params: FetchParams & { interactionExternalId: string },
  ): Promise<Result<NormalizedInteraction>>;

  publishReply(params: PublishParams): Promise<Result<PublicationReceipt>>;
  getPublicationStatus(
    params: Omit<PublishParams, 'content'> & { expectedContent: string },
  ): Promise<Result<PublicationReceipt>>;

  /** Verifica firma, deduplica y normaliza. Firmas inválidas → not_authorized. */
  handleWebhook(req: WebhookRequest): Promise<Result<WebhookEvent[]>>;
  getHealthStatus(credentials: ProviderCredentials): Promise<ConnectorHealth>;
}
