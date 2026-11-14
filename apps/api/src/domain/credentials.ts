/**
 * Credenciales de proveedores (Connected Accounts). Solo backend y worker:
 * los tokens se sellan antes de tocar la base de datos y se abren en memoria
 * justo antes de usarlos. Nunca se registran en logs ni se devuelven por la API.
 */
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import {
  FacebookPageConnector,
  GoogleBusinessConnector,
  InstagramBusinessConnector,
  MetaGraph,
  type ConnectorError,
  type MetaOptions,
  type ProviderCredentials,
} from '@rep/connectors';
import type { Config } from '../config';
import type { Tx } from '../lib/db';
import { createSecretBox, type SecretBox } from '../lib/secrets';

export type RealProvider = 'google_business_profile' | 'facebook_page' | 'instagram_business';
/** Proveedor de la autorización: un inicio de sesión de Meta sirve para Facebook e Instagram. */
export type CredentialProvider = 'google_business_profile' | 'meta';

export interface MetaIntegration {
  graph: () => MetaGraph;
  facebook: () => FacebookPageConnector;
  instagram: () => InstagramBusinessConnector;
  appSecret: string;
  /** null = webhooks sin configurar: se sincroniza solo por sondeo. */
  webhookVerifyToken: string | null;
  graphVersion: string;
}

export interface Integrations {
  box: SecretBox | null;
  /** null = Google no configurado en este entorno (falta cliente OAuth o clave de cifrado). */
  google: (() => GoogleBusinessConnector) | null;
  googleRedirectUri: string;
  /** null = Meta no configurado (falta la app de Meta o la clave de cifrado). */
  meta: MetaIntegration | null;
  metaRedirectUri: string;
  metaWebhookUrl: string;
}

export function createIntegrations(
  config: Pick<
    Config,
    | 'CREDENTIALS_ENCRYPTION_KEYS'
    | 'GOOGLE_OAUTH_CLIENT_ID'
    | 'GOOGLE_OAUTH_CLIENT_SECRET'
    | 'GOOGLE_TIMEOUT_MS'
    | 'API_PUBLIC_URL'
    | 'META_APP_ID'
    | 'META_APP_SECRET'
    | 'META_WEBHOOK_VERIFY_TOKEN'
    | 'META_GRAPH_VERSION'
    | 'META_POSTS_PER_SYNC'
    | 'META_TIMEOUT_MS'
  >,
  opts: { fetch?: typeof fetch } = {},
): Integrations {
  const box = config.CREDENTIALS_ENCRYPTION_KEYS
    ? createSecretBox(config.CREDENTIALS_ENCRYPTION_KEYS)
    : null;
  const g =
    box && config.GOOGLE_OAUTH_CLIENT_ID && config.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          clientId: config.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
          timeoutMs: config.GOOGLE_TIMEOUT_MS,
          fetch: opts.fetch,
        }
      : null;
  const m: MetaOptions | null =
    box && config.META_APP_ID && config.META_APP_SECRET
      ? {
          appId: config.META_APP_ID,
          appSecret: config.META_APP_SECRET,
          graphVersion: config.META_GRAPH_VERSION,
          postsPerSync: config.META_POSTS_PER_SYNC,
          timeoutMs: config.META_TIMEOUT_MS,
          fetch: opts.fetch,
        }
      : null;
  const base = config.API_PUBLIC_URL.replace(/\/$/, '');
  return {
    box,
    google: g ? () => new GoogleBusinessConnector(g) : null,
    googleRedirectUri: `${base}/v1/oauth/google/callback`,
    meta: m
      ? {
          graph: () => new MetaGraph(m),
          facebook: () => new FacebookPageConnector(m),
          instagram: () => new InstagramBusinessConnector(m),
          appSecret: m.appSecret,
          webhookVerifyToken: config.META_WEBHOOK_VERIFY_TOKEN ?? null,
          graphVersion: config.META_GRAPH_VERSION ?? 'v26.0',
        }
      : null,
    metaRedirectUri: `${base}/v1/oauth/meta/callback`,
    metaWebhookUrl: `${base}/v1/webhooks/meta`,
  };
}

/** Referencia no reversible al usuario del proveedor (no se guarda su id en claro). */
export function providerUserRef(secret: string, provider: string, id: string) {
  return createHmac('sha256', secret).update(`${provider}:${id}`).digest('hex');
}

/** Token de una página de Meta, sellado junto al token de usuario. */
export interface StoredPage {
  token: string;
  name: string;
  tasks: string[];
  instagramId?: string;
}

interface Stored {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
  /** Solo Meta: tokens de página por id de página. */
  pages?: Record<string, StoredPage>;
}

export async function saveCredential(
  tx: Tx,
  box: SecretBox,
  input: {
    organizationId: string;
    clientId: string;
    provider: CredentialProvider;
    credentials: ProviderCredentials;
    userId: string;
    pages?: Record<string, StoredPage>;
    providerUserRef?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const c = input.credentials;
  const payload: Stored = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt?.toISOString(),
    scopes: c.scopes,
    pages: input.pages,
  };
  await tx`
    insert into private.provider_credentials
      (id, organization_id, client_id, provider, sealed, key_id, scopes, access_expires_at, authorized_by, provider_user_ref)
    values (${id}, ${input.organizationId}, ${input.clientId}, ${input.provider},
            ${box.seal(JSON.stringify(payload), id)}, ${box.keyId}, ${c.scopes}, ${c.expiresAt ?? null}, ${input.userId},
            ${input.providerUserRef ?? null})`;
  return id;
}

export interface CredentialRow {
  id: string;
  organizationId: string;
  clientId: string;
  provider: CredentialProvider;
  scopes: string[];
  providerUserRef: string | null;
  authorizedBy: string | null;
  authorizedAt: Date;
  revokedAt: Date | null;
}

export async function loadCredential(
  tx: Tx,
  box: SecretBox,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{
  row: CredentialRow;
  credentials: ProviderCredentials;
  pages: Record<string, StoredPage>;
} | null> {
  const [r] = await tx<(CredentialRow & { sealed: string })[]>`
    select id, organization_id, client_id, provider, scopes, provider_user_ref, authorized_by, authorized_at, revoked_at, sealed
      from private.provider_credentials where id = ${id} ${opts.forUpdate ? tx`for update` : tx``}`;
  if (!r) return null;
  const s = JSON.parse(box.open(r.sealed, r.id)) as Stored;
  const { sealed: _s, ...row } = r;
  return {
    row,
    credentials: {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      expiresAt: s.expiresAt ? new Date(s.expiresAt) : undefined,
      scopes: s.scopes,
    },
    pages: s.pages ?? {},
  };
}

export async function updateCredential(
  tx: Tx,
  box: SecretBox,
  id: string,
  c: ProviderCredentials,
  pages?: Record<string, StoredPage>,
) {
  const payload: Stored = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt?.toISOString(),
    scopes: c.scopes,
    pages,
  };
  await tx`
    update private.provider_credentials
       set sealed = ${box.seal(JSON.stringify(payload), id)}, key_id = ${box.keyId}, scopes = ${c.scopes},
           access_expires_at = ${c.expiresAt ?? null}, refreshed_at = now(), last_error_kind = null
     where id = ${id}`;
}

/** Margen para refrescar antes de que caduque el token de acceso. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export function needsRefresh(c: ProviderCredentials, now = Date.now()) {
  return !c.expiresAt || c.expiresAt.getTime() - now < REFRESH_MARGIN_MS;
}

export type ResolveError = ConnectorError;
