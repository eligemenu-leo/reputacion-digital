/**
 * Catálogo de permisos. Debe coincidir exactamente con la tabla public.permissions
 * (supabase/migrations/*_rbac_catalog.sql). Un test de base de datos lo verifica.
 */
export const PERMISSIONS = {
  // Plataforma
  'platform.organizations.manage': 'platform',
  'platform.settings.manage': 'platform',
  'platform.integrations.monitor': 'platform',
  'platform.ai.configure': 'platform',
  // Organización
  'organization.read': 'organization',
  'organization.manage': 'organization',
  'members.manage': 'organization',
  'roles.manage': 'organization',
  'clients.create': 'organization',
  'audit.read': 'organization',
  'alerts.manage': 'organization',
  // Cliente
  'clients.read': 'client',
  'clients.update': 'client',
  'brand.write': 'client',
  'connections.read': 'client',
  'connections.manage': 'client',
  'interactions.read': 'client',
  'interactions.update': 'client',
  'drafts.write': 'client',
  'approvals.request': 'client',
  'responses.approve': 'client',
  'responses.publish': 'client',
  'reports.read': 'client',
  'alerts.read': 'client',
} as const satisfies Record<string, 'platform' | 'organization' | 'client'>;

export type Permission = keyof typeof PERMISSIONS;
export type PermissionScope = (typeof PERMISSIONS)[Permission];

export const SYSTEM_ROLES = ['org_admin', 'account_manager', 'approver', 'client_viewer'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLES)[number];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function permissionsByScope(scope: PermissionScope): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => PERMISSIONS[p] === scope);
}
