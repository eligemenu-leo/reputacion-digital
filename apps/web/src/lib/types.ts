import type { ClientStatus, Permission } from '@rep/shared';

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  allClientsAccess: boolean;
  roleKey: string;
  roleName: string;
  permissions: Permission[];
}

export interface Me {
  user: { id: string; email: string | null; aal: 'aal1' | 'aal2' };
  profile: {
    id: string;
    email: string | null;
    fullName: string | null;
    locale: string;
    timezone: string;
  } | null;
  isPlatformAdmin: boolean;
  memberships: Membership[];
}

export interface ClientListItem {
  id: string;
  name: string;
  sector: string | null;
  status: ClientStatus;
  website: string | null;
  primaryLanguage: string;
  timezone: string;
  onboardedAt: string;
  createdAt: string;
  accountManagerId: string | null;
  accountManagerName: string | null;
  accountManagerEmail: string | null;
  locationsCount: number;
}

export interface Location {
  id: string;
  clientId: string;
  name: string;
  addressLine: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  phone: string | null;
  timezone: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

export interface ClientDetail {
  id: string;
  organizationId: string;
  name: string;
  legalName: string | null;
  sector: string | null;
  description: string | null;
  website: string | null;
  phone: string | null;
  primaryLanguage: string;
  timezone: string;
  accountManagerId: string | null;
  status: ClientStatus;
  onboardedAt: string;
  businessContext: string | null;
  aiEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  locations: Location[];
  members: {
    id: string;
    userId: string;
    email: string | null;
    fullName: string | null;
    extraRoleKey: string | null;
    extraRoleName: string | null;
  }[];
  permissions: { canUpdate: boolean; canManageMembers: boolean };
}

export interface Member {
  id: string;
  userId: string;
  status: 'invited' | 'active' | 'suspended';
  allClientsAccess: boolean;
  email: string | null;
  fullName: string | null;
  roleId: string;
  roleKey: string;
  roleName: string;
  assignedClients: number;
  createdAt: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Permission[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
