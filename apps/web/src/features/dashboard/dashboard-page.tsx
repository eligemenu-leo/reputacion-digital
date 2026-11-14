import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, Building2, CheckSquare, Inbox, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import { CLIENT_STATUS } from '@/lib/labels';
import { Badge, Card, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import type { ClientStatus } from '@rep/shared';

interface Overview {
  counts: {
    clientsTotal: number;
    clientsActive: number;
    clientsOnboarding: number;
    locationsActive: number;
    membersActive: number;
  };
  inbox: {
    open: number;
    highPriority: number;
    pendingApproval: number;
    publishFailed: number;
    published7d: number;
    received7d: number;
    simulated: number;
  };
  sources: { total: number; connected: number; withErrors: number; simulated: number };
  recentClients: { id: string; name: string; status: ClientStatus; createdAt: string }[];
  modules: Record<
    string,
    { status: 'not_available' | 'available' | 'simulator_only'; availableIn?: string }
  >;
}

const MODULES: { key: string; label: string; detail: string }[] = [
  {
    key: 'connectedSources',
    label: 'Fuentes conectadas',
    detail: 'Google Business Profile, Facebook, Instagram y web',
  },
  {
    key: 'inbox',
    label: 'Bandeja de reputación',
    detail: 'Reseñas, comentarios y menciones unificados',
  },
  { key: 'approvals', label: 'Aprobaciones', detail: 'Revisión humana antes de publicar' },
  { key: 'sentiment', label: 'Análisis IA', detail: 'Sentimiento, temas y prioridad' },
  { key: 'alerts', label: 'Alertas e informes', detail: 'Avisos de riesgo y resúmenes periódicos' },
];

const phaseLabel = (p: string) => `Fase ${p.replace('phase_', '')}`;

export function DashboardPage() {
  const { orgId, membership } = useOrg();
  const q = useQuery({
    queryKey: ['overview', orgId],
    queryFn: () => api<Overview>(`/organizations/${orgId}/overview`),
  });

  const base = `/o/${orgId}`;
  const stats = q.data
    ? [
        {
          label: 'Interacciones abiertas',
          value: q.data.inbox.open,
          sub: `${q.data.inbox.highPriority} de prioridad alta o crítica`,
          icon: Inbox,
          to: `${base}/bandeja`,
        },
        {
          label: 'Pendientes de aprobación',
          value: q.data.inbox.pendingApproval,
          sub: 'Esperando revisión humana',
          icon: CheckSquare,
          to: `${base}/aprobaciones`,
        },
        {
          label: 'Publicadas (7 días)',
          value: q.data.inbox.published7d,
          sub: `${q.data.inbox.received7d} recibidas en 7 días`,
          icon: Send,
          to: `${base}/bandeja?view=done`,
        },
        {
          label: 'Clientes',
          value: q.data.counts.clientsTotal,
          sub: `${q.data.counts.clientsActive} activos · ${q.data.counts.locationsActive} ubicaciones`,
          icon: Building2,
          to: `${base}/clientes`,
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Panel"
        description={membership ? `Resumen de ${membership.organizationName}` : undefined}
      />
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {q.data && (q.data.inbox.publishFailed > 0 || q.data.sources.withErrors > 0) && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {q.data.inbox.publishFailed > 0 && (
              <Link to={`${base}/bandeja?view=failed`} className="underline">
                {q.data.inbox.publishFailed} publicaciones con error
              </Link>
            )}
            {q.data.inbox.publishFailed > 0 && q.data.sources.withErrors > 0 && ' · '}
            {q.data.sources.withErrors > 0 && (
              <Link to={`${base}/fuentes`} className="underline">
                {q.data.sources.withErrors} fuentes con problemas
              </Link>
            )}
          </span>
        </div>
      )}
      {q.data && q.data.inbox.simulated > 0 && (
        <p className="mb-4 text-xs text-muted">
          Incluye {q.data.inbox.simulated} interacciones ficticias del proveedor simulado.
        </p>
      )}
      <section aria-label="Indicadores" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {q.isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))
          : stats.map((s) => (
              <Link key={s.label} to={s.to} className="rounded-xl focus-visible:outline-2">
                <Card className="h-full p-5 transition-colors hover:bg-surface-2/60">
                  <div className="flex items-center justify-between text-sm text-muted">
                    {s.label}
                    <s.icon className="size-4" aria-hidden />
                  </div>
                  <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">
                    {s.value}
                  </p>
                  <p className="mt-1 text-xs text-muted">{s.sub}</p>
                </Card>
              </Link>
            ))}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold">Clientes recientes</h2>
            <Link
              to={`/o/${orgId}/clientes`}
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              Ver todos <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <ul className="divide-y divide-border">
            {q.data?.recentClients.length === 0 && (
              <li className="px-5 py-8 text-center text-sm text-muted">Todavía no hay clientes.</li>
            )}
            {q.data?.recentClients.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/o/${orgId}/clientes/${c.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-2"
                >
                  <span className="truncate text-sm font-medium">{c.name}</span>
                  <Badge tone={CLIENT_STATUS[c.status].tone}>{CLIENT_STATUS[c.status].label}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-2">
          <div className="border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold">Estado de los módulos</h2>
            <p className="mt-0.5 text-xs text-muted">
              Las métricas solo proceden de módulos operativos.
            </p>
          </div>
          <ul className="divide-y divide-border">
            {MODULES.map((m) => {
              const st = q.data?.modules[m.key];
              return (
                <li key={m.key} className="flex items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{m.label}</p>
                    <p className="text-xs text-muted">{m.detail}</p>
                  </div>
                  <Badge
                    tone={
                      st?.status === 'available'
                        ? 'success'
                        : st?.status === 'simulator_only'
                          ? 'accent'
                          : 'neutral'
                    }
                  >
                    {!st
                      ? '—'
                      : st.status === 'available'
                        ? 'Operativo'
                        : st.status === 'simulator_only'
                          ? `Solo simulador · reales en ${phaseLabel(st.availableIn ?? '')}`
                          : `Pendiente · ${phaseLabel(st.availableIn ?? '')}`}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
