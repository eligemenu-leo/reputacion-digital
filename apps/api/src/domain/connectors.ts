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
 * Simulador (solo fuera de producción) y Google Business Profile cuando hay
 * cliente OAuth y clave de cifrado. Facebook e Instagram llegarán en el
 * siguiente bloque; hasta entonces devuelven null y la sincronización se
 * marca como «no disponible», sin simular éxito.
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

/** El simulador nunca puede usarse en producción. */
export function assertSimulatorAllowed(nodeEnv: string) {
  if (nodeEnv === 'production') {
    throw new AppError('FORBIDDEN', 'El proveedor simulado no está disponible en producción');
  }
}
