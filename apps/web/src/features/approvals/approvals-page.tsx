import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CheckSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import { fmtDateTime, providerLabel } from '@/lib/inbox';
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { ApprovalPanel } from '@/features/inbox/approval-panel';
import { PriorityBadge, RiskBadges, SimulatedBadge, Stars } from '@/features/inbox/parts';

interface ApprovalItem {
  id: string;
  clientName: string;
  provider: string;
  authorDisplayName: string | null;
  content: string | null;
  rating: string | null;
  ratingScale: number | null;
  priority: number;
  riskFlags: string[];
  requiresSpecialist: boolean;
  approvalRequestedAt: string | null;
  approvalRequestedByName: string | null;
  isSimulated: boolean;
  draftVersion: number;
  draftContent: string;
}

/** Bandeja de aprobación pensada también para móvil: una tarjeta por respuesta. */
export function ApprovalsPage() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['approvals', orgId],
    queryFn: () => api<{ items: ApprovalItem[] }>(`/organizations/${orgId}/approvals`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['approvals', orgId] });
    void qc.invalidateQueries({ queryKey: ['inbox', orgId] });
  };

  return (
    <>
      <PageHeader
        title="Aprobaciones"
        description="Respuestas que esperan tu revisión. Nada se publica sin aprobación humana."
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : q.data?.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CheckSquare className="size-5" aria-hidden />}
            title="No hay respuestas pendientes"
            description="Cuando un gestor envíe una respuesta a aprobación de un cliente en el que puedas aprobar, aparecerá aquí."
          />
        </Card>
      ) : (
        <ul className="mx-auto max-w-3xl space-y-5">
          {q.data?.items.map((a) => (
            <li key={a.id}>
              <Card className="overflow-hidden">
                <div className="border-b border-border p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Link
                      to={`/o/${orgId}/bandeja/${a.id}`}
                      className="font-medium text-fg hover:underline"
                    >
                      {a.authorDisplayName ?? 'Anónimo'}
                    </Link>
                    <Stars rating={a.rating} scale={a.ratingScale} />
                    <span>
                      · {a.clientName} · {providerLabel(a.provider)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">
                    {a.content ?? <em className="text-muted">Valoración sin texto</em>}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.priority !== 2 && <PriorityBadge priority={a.priority} />}
                    <RiskBadges flags={a.riskFlags} />
                    {a.isSimulated && <SimulatedBadge />}
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Solicitada por {a.approvalRequestedByName ?? '—'} ·{' '}
                    {fmtDateTime(a.approvalRequestedAt)}
                  </p>
                </div>
                <ApprovalPanel
                  compact
                  interactionId={a.id}
                  draft={{ content: a.draftContent, version: a.draftVersion }}
                  requiresSpecialist={a.requiresSpecialist}
                  isSimulated={a.isSimulated}
                  provider={a.provider}
                  onDone={refresh}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
