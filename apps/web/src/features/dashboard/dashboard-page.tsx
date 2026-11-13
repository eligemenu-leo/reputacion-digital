import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRight, Building2, MapPin, Users } from 'lucide-react';
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
  recentClients: { id: string; name: string; status: ClientStatus; createdAt: string }[];
  modules: Record<string, { status: 'not_available'; availableIn: string }>;
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

  const stats = q.data
    ? [
        {
          label: 'Clientes',
          value: q.data.counts.clientsTotal,
          sub: `${q.data.counts.clientsActive} activos · ${q.data.counts.clientsOnboarding} en alta`,
          icon: Building2,
        },
        {
          label: 'Ubicaciones activas',
          value: q.data.counts.locationsActive,
          sub: 'Establecimientos registrados',
          icon: MapPin,
        },
        {
          label: 'Equipo',
          value: q.data.counts.membersActive,
          sub: 'Usuarios activos',
          icon: Users,
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

      <section aria-label="Indicadores" className="grid gap-4 sm:grid-cols-3">
        {q.isLoading
          ? Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))
          : stats.map((s) => (
              <Card key={s.label} className="p-5">
                <div className="flex items-center justify-between text-sm text-muted">
                  {s.label}
                  <s.icon className="size-4" aria-hidden />
                </div>
                <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{s.value}</p>
                <p className="mt-1 text-xs text-muted">{s.sub}</p>
              </Card>
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
              Solo se muestran métricas de módulos operativos.
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
                  <Badge tone="neutral">
                    {st ? `Pendiente · ${phaseLabel(st.availableIn)}` : '—'}
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
