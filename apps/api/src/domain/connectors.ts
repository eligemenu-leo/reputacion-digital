import {
  SimulatorConnector,
  type ProviderConnector,
  type ProviderCredentials,
  type SimulatorConfig,
} from '@rep/connectors';
import { AppError } from '@rep/shared';
import type { Sql } from '../lib/db';
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

export interface ConnectorRegistry {
  /** Devuelve el conector y unas credenciales utilizables, o null si el proveedor no está disponible. */
  resolve(
    account: AccountRow,
  ): Promise<{ connector: ProviderConnector; credentials: ProviderCredentials } | null>;
}

/**
 * Solo el simulador está disponible en Fase 2. Google y Meta se añadirán en
 * Fase 4 cuando haya acceso aprobado a sus API; hasta entonces devuelven
 * null y la sincronización se marca como «no disponible», sin simular éxito.
 */
export function createConnectorRegistry(sql: Sql): ConnectorRegistry {
  const store = new DbSimulatorStore(sql);
  return {
    async resolve(account) {
      if (account.provider !== 'simulator') return null;
      const connector = new SimulatorConnector(
        store,
        account.id,
        account.config as SimulatorConfig,
      );
      return { connector, credentials: { accessToken: 'simulator', scopes: ['simulator'] } };
    },
  };
}

/** El simulador nunca puede usarse en producción. */
export function assertSimulatorAllowed(nodeEnv: string) {
  if (nodeEnv === 'production') {
    throw new AppError('FORBIDDEN', 'El proveedor simulado no está disponible en producción');
  }
}
