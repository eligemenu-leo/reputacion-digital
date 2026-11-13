import { AppError } from '@rep/shared';
import type { Config } from '../config';

/**
 * Cliente mínimo de la Auth Admin API de Supabase (solo backend).
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY; si faltan, la operación
 * se rechaza explícitamente en lugar de simular éxito.
 */
export interface AuthAdmin {
  inviteUser(email: string, redirectTo: string): Promise<{ userId: string }>;
}

export function createAuthAdmin(
  config: Pick<Config, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
): AuthAdmin {
  return {
    async inviteUser(email, redirectTo) {
      if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
        throw new AppError(
          'NOT_SUPPORTED',
          'Las invitaciones por email requieren configurar SUPABASE_SERVICE_ROLE_KEY',
        );
      }
      // GoTrue lee redirect_to de la query string (igual que supabase-js inviteUserByEmail).
      const url = `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          apikey: config.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, data: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          `No se pudo enviar la invitación (HTTP ${res.status})`,
        );
      }
      const body = (await res.json()) as { id?: string };
      if (!body.id)
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Respuesta de invitación inesperada');
      return { userId: body.id };
    },
  };
}
