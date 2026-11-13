import { useParams } from 'react-router';
import type { Permission } from '@rep/shared';
import { useMe } from '@/features/auth/auth-context';

export function useOrg() {
  const { orgId } = useParams<{ orgId: string }>();
  const me = useMe();
  const membership = me.data?.memberships.find((m) => m.organizationId === orgId) ?? null;
  const isPlatformAdmin = me.data?.isPlatformAdmin ?? false;
  const can = (p: Permission) => isPlatformAdmin || (membership?.permissions.includes(p) ?? false);
  return { orgId: orgId!, membership, isPlatformAdmin, can, me: me.data };
}
