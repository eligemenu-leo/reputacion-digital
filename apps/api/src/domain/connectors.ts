import {
  SimulatorConnector,
  type ConnectorError,
  type ProviderConnector,
  type ProviderCredentials,
  type SimulatorConfig,
} from '@rep/connectors';
import { AppError } from '@rep/shared';
import { withService, type Sql } from '../lib/db';
import { loadCredential, needsRefresh, updateCredential, type Integrations } from './credentials';
import { DbSimulatorStore } from './simulator-store';

export interface AccountRow {
  id: string;
  organizationId: string;
  clientId: string;
  locationId: string | null;
  provider: string;
  externalAccountId: string;
  status: string;
  config: Record<string, unknown>;
  lastSuccessSyncAt: Date | null;
}

export type Resolved =
  | { connector: ProviderConnector; credentials: ProviderCredentials }
  /** El proveedor existe pero no se puede usar ahora (credencial caducada, refresco fallido…). */
  | { error: ConnectorError }
  /** Proveedor no disponible en este entorno. */
  | null;

export interface ConnectorRegistry {
  resolve(account: AccountRow): Promise<Resolved>;
}

const NOT_CONFIGURED: ConnectorError = {
  kind: 'not_supported',
  message: 'Esta integración no está configurada en este entorno',
  retryable: false,
};

/**
 * Simulador (solo fuera de producción), Google Business Profile, páginas de
 * Facebook e Instagram profesional cuando están configurados. Un proveedor
 * sin configurar devuelve un error explícito, nunca un éxito simulado.
 */
export function createConnectorRegistry(sql: Sql, integrations?: Integrations): ConnectorRegistry {
  const store = new DbSimulatorStore(sql);
  return {
    async resolve(account) {
      if (account.provider === 'simulator') {
        const connector = new SimulatorConnector(
          store,
          account.id,
          account.config as SimulatorConfig,
        );
        return { connector, credentials: { accessToken: 'simulator', scopes: ['simulator'] } };
      }
      if (account.provider === 'google_business_profile') {
        if (!integrations?.google || !integrations.box) return { error: NOT_CONFIGURED };
        const [a] = await sql<{ credentialId: string | null }[]>`
          select credential_id from public.connected_accounts where id = ${account.id}`;
        if (!a?.credentialId) {
          return {
            error: {
              kind: 'credentials_expired',
              message: 'La fuente no tiene autorización: vuelve a conectar Google',
              retryable: false,
            },
          };
        }
        return useCredential(sql, integrations, a.credentialId);
      }
      if (account.provider === 'facebook_page' || account.provider === 'instagram_business') {
        if (!integrations?.meta || !integrations.box) return { error: NOT_CONFIGURED };
        const [a] = await sql<{ credentialId: string | null }[]>`
          select credential_id from public.connected_accounts where id = ${account.id}`;
        const pageId = (account.config as { pageId?: string }).pageId;
        if (!a?.credentialId || !pageId) {
          return {
            error: {
              kind: 'credentials_expired',
              message: 'La fuente no tiene autorización: vuelve a conectar con Meta',
              retryable: false,
            },
          };
        }
        return useMetaCredential(sql, integrations, a.credentialId, account.provider, pageId);
      }
      return null;
    },
  };
}

/**
 * Abre una credencial de Google y la refresca si está a punto de caducar.
 * La fila se bloquea mientras tanto: dos trabajos no refrescan el mismo token a la vez.
 */
export async function useCredential(
  sql: Sql,
  integrations: Integrations,
  credentialId: string,
): Promise<Exclude<Resolved, null>> {
  const make = integrations.google;
  const box = integrations.box;
  if (!make || !box) return { error: NOT_CONFIGURED };
  const connector = make();
  return withService(sql, null, async (tx) => {
    const loaded = await loadCredential(tx, box, credentialId, { forUpdate: true });
    if (!loaded || loaded.row.revokedAt) {
      return {
        error: {
          kind: 'credentials_expired',
          message: 'La autorización de Google se ha revocado',
          retryable: false,
        } satisfies ConnectorError,
      };
    }
    let creds = loaded.credentials;
    if (needsRefresh(creds)) {
      const r = await connector.refreshCredentials(creds);
      if (!r.ok) {
        await tx`update private.provider_credentials set last_error_kind = ${r.error.kind} where id = ${credentialId}`;
        return { error: r.error };
      }
      creds = r.value;
      await updateCredential(tx, box, credentialId, creds);
    }
    return { connector, credentials: creds };
  });
}

/**
 * Abre una credencial de Meta y entrega el token de la página indicada. Los
 * tokens de página no se refrescan por tiempo: si Meta los invalida, la API
 * devuelve 190 y la fuente pasa a «credenciales caducadas».
 */
export async function useMetaCredential(
  sql: Sql,
  integrations: Integrations,
  credentialId: string,
  provider: 'facebook_page' | 'instagram_business',
  pageId: string,
): Promise<Exclude<Resolved, null>> {
  const meta = integrations.meta;
  const box = integrations.box;
  if (!meta || !box) return { error: NOT_CONFIGURED };
  const loaded = await withService(sql, null, (tx) => loadCredential(tx, box, credentialId));
  const page = loaded?.pages[pageId];
  if (!loaded || loaded.row.revokedAt || !page) {
    return {
      error: {
        kind: 'credentials_expired',
        message: 'La autorización de Meta ya no incluye esta página: vuelve a conectar',
        retryable: false,
      },
    };
  }
  return {
    connector: provider === 'facebook_page' ? meta.facebook() : meta.instagram(),
    credentials: { accessToken: page.token, scopes: loaded.credentials.scopes, meta: { pageId } },
  };
}

/** El simulador nunca puede usarse en producción. */
export function assertSimulatorAllowed(nodeEnv: string) {
  if (nodeEnv === 'production') {
    throw new AppError('FORBIDDEN', 'El proveedor simulado no está disponible en producción');
  }
}
