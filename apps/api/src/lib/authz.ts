import { AppError, type Permission } from '@rep/shared';
import type { AuthContext } from './auth';
import type { Tx } from './db';

/**
 * Comprobaciones de autorización en servidor. Reutilizan las mismas funciones
 * SQL que las políticas RLS, de modo que API y base de datos no divergen.
 * Deben ejecutarse dentro de withUser (claims establecidas).
 */
export async function isPlatformAdmin(tx: Tx): Promise<boolean> {
  const [r] = await tx<{ v: boolean }[]>`select private.is_platform_admin() as v`;
  return r?.v === true;
}

export async function requireOrgPermission(
  tx: Tx,
  auth: AuthContext,
  orgId: string,
  perm: Permission,
  opts: { sensitive?: boolean; enforceMfa?: boolean } = {},
): Promise<void> {
  const [r] = await tx<{ v: boolean; mfa: boolean | null }[]>`
    select private.has_org_permission(${orgId}::uuid, ${perm}) as v,
           (select require_admin_mfa from public.organizations where id = ${orgId}::uuid) as mfa`;
  if (!r?.v) throw new AppError('FORBIDDEN', 'No tienes permiso para esta acción');
  if (opts.sensitive && opts.enforceMfa && r.mfa !== false && auth.aal !== 'aal2') {
    throw new AppError('MFA_REQUIRED', 'Esta acción requiere verificación en dos pasos (MFA)');
  }
}

export async function requireClientPermission(
  tx: Tx,
  clientId: string,
  perm: Permission,
): Promise<void> {
  const [r] = await tx<
    { v: boolean }[]
  >`select private.has_client_permission(${clientId}::uuid, ${perm}) as v`;
  if (!r?.v) {
    // 404 en vez de 403 para no revelar la existencia de clientes ajenos.
    throw new AppError('NOT_FOUND', 'Cliente no encontrado');
  }
}

export async function requirePlatformAdmin(
  tx: Tx,
  auth: AuthContext,
  enforceMfa: boolean,
): Promise<void> {
  if (!(await isPlatformAdmin(tx))) throw new AppError('FORBIDDEN', 'Solo superadministradores');
  if (enforceMfa && auth.aal !== 'aal2') {
    throw new AppError('MFA_REQUIRED', 'Esta acción requiere verificación en dos pasos (MFA)');
  }
}

/** Cliente visible (si no, 404) y permiso concreto sobre él (si no, 403). */
export async function requireClientAction(
  tx: Tx,
  clientId: string,
  perm: Permission,
): Promise<void> {
  await requireClientPermission(tx, clientId, 'clients.read');
  const [r] = await tx<
    { v: boolean }[]
  >`select private.has_client_permission(${clientId}::uuid, ${perm}) as v`;
  if (!r?.v) throw new AppError('FORBIDDEN', 'No tienes permiso para esta acción');
}
