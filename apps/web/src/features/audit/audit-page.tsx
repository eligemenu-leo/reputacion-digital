import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { formatInTimeZone } from '@rep/shared';

interface AuditRow {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actorType: string;
  actorEmail: string | null;
  actorName: string | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
}

const ACTIONS: Record<string, string> = { insert: 'creó', update: 'modificó', delete: 'eliminó' };
const ENTITIES: Record<string, string> = {
  clients: 'cliente',
  client_locations: 'ubicación',
  organization_members: 'miembro',
  client_members: 'asignación',
  organizations: 'organización',
  roles: 'rol',
  role_permissions: 'permiso de rol',
  brand_profiles: 'personalidad de marca',
  brand_profile_versions: 'versión de marca',
};

function describe(r: AuditRow) {
  const [, op] = r.action.split('.');
  const who =
    r.actorName ??
    r.actorEmail ??
    (r.actorType === 'system' ? 'Sistema' : 'Usuario externo a la organización');
  const fields = op === 'update' && r.changes ? Object.keys(r.changes).join(', ') : null;
  return {
    who,
    text: `${ACTIONS[op ?? ''] ?? op} ${ENTITIES[r.entityType] ?? r.entityType}`,
    fields,
  };
}

export function AuditPage() {
  const { orgId, me } = useOrg();
  const tz = me?.profile?.timezone ?? 'Europe/Madrid';
  const q = useQuery({
    queryKey: ['audit', orgId],
    queryFn: () => api<AuditRow[]>(`/organizations/${orgId}/audit`),
  });
  return (
    <>
      <PageHeader
        title="Auditoría"
        description="Registro inmutable de cambios relevantes. Se muestran los 100 más recientes."
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      <Card>
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : q.data?.length === 0 ? (
          <EmptyState title="Sin actividad registrada" />
        ) : (
          <ol className="divide-y divide-border">
            {q.data?.map((r) => {
              const d = describe(r);
              return (
                <li
                  key={r.id}
                  className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <time
                    dateTime={r.createdAt}
                    className="w-40 shrink-0 text-xs tabular-nums text-muted"
                  >
                    {formatInTimeZone(r.createdAt, tz)}
                  </time>
                  <p className="min-w-0 flex-1 text-sm">
                    <span className="font-medium">{d.who}</span> {d.text}
                    {d.fields && <span className="text-muted"> · {d.fields}</span>}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </>
  );
}
