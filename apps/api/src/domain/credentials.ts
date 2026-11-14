/**
 * Credenciales de proveedores (Connected Accounts). Solo backend y worker:
 * los tokens se sellan antes de tocar la base de datos y se abren en memoria
 * justo antes de usarlos. Nunca se registran en logs ni se devuelven por la API.
 */
import { randomUUID } from 'node:crypto';
import {
  GoogleBusinessConnector,
  type ConnectorError,
  type ProviderCredentials,
} from '@rep/connectors';
import type { Config } from '../config';
import type { Tx } from '../lib/db';
import { createSecretBox, type SecretBox } from '../lib/secrets';

export type RealProvider = 'google_business_profile' | 'facebook_page' | 'instagram_business';

export interface Integrations {
  box: SecretBox | null;
  /** null = Google no configurado en este entorno (falta cliente OAuth o clave de cifrado). */
  google: (() => GoogleBusinessConnector) | null;
  googleRedirectUri: string;
}

export function createIntegrations(
  config: Pick<
    Config,
    | 'CREDENTIALS_ENCRYPTION_KEYS'
    | 'GOOGLE_OAUTH_CLIENT_ID'
    | 'GOOGLE_OAUTH_CLIENT_SECRET'
    | 'GOOGLE_TIMEOUT_MS'
    | 'API_PUBLIC_URL'
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
  return {
    box,
    google: g ? () => new GoogleBusinessConnector(g) : null,
    googleRedirectUri: `${config.API_PUBLIC_URL.replace(/\/$/, '')}/v1/oauth/google/callback`,
  };
}

interface Stored {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
}

export async function saveCredential(
  tx: Tx,
  box: SecretBox,
  input: {
    organizationId: string;
    clientId: string;
    provider: RealProvider;
    credentials: ProviderCredentials;
    userId: string;
  },
): Promise<string> {
  const id = randomUUID();
  const c = input.credentials;
  const payload: Stored = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt?.toISOString(),
    scopes: c.scopes,
  };
  await tx`
    insert into private.provider_credentials
      (id, organization_id, client_id, provider, sealed, key_id, scopes, access_expires_at, authorized_by)
    values (${id}, ${input.organizationId}, ${input.clientId}, ${input.provider},
            ${box.seal(JSON.stringify(payload), id)}, ${box.keyId}, ${c.scopes}, ${c.expiresAt ?? null}, ${input.userId})`;
  return id;
}

export interface CredentialRow {
  id: string;
  organizationId: string;
  clientId: string;
  provider: RealProvider;
  scopes: string[];
  authorizedBy: string | null;
  authorizedAt: Date;
  revokedAt: Date | null;
}

export async function loadCredential(
  tx: Tx,
  box: SecretBox,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ row: CredentialRow; credentials: ProviderCredentials } | null> {
  const [r] = await tx<(CredentialRow & { sealed: string })[]>`
    select id, organization_id, client_id, provider, scopes, authorized_by, authorized_at, revoked_at, sealed
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
  };
}

export async function updateCredential(tx: Tx, box: SecretBox, id: string, c: ProviderCredentials) {
  const payload: Stored = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt?.toISOString(),
    scopes: c.scopes,
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
