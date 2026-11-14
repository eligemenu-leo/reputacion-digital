import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, BarChart3, Bot, FileText } from 'lucide-react';
import {
  FINDING_KIND_LABELS_ES,
  PROVIDER_LABELS_ES,
  REPORT_STATUS_LABELS_ES,
  type ReportStatus,
} from '@rep/shared';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { ClientListItem, Paginated } from '@/lib/types';
import { fmtDateTime } from '@/lib/inbox';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  type Tone,
} from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

interface Metrics {
  period: { from: string; to: string; days: number };
  previous_period: { from: string; to: string };
  total: number;
  with_text: number;
  simulated: number;
  rating_count: number;
  rating_avg: number | null;
  rating_distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  negative_pct: number;
  positive_pct: number;
  responded: number;
  response_rate_pct: number;
  median_response_hours: number | null;
  risk_flagged: number;
  specialist_required: number;
  by_provider: { provider: string; count: number; rating_avg: number | null }[];
  topics: {
    topic: string;
    count: number;
    rating_avg: number | null;
    negative_pct: number;
    positive_pct: number;
    previous_count: number;
  }[];
  previous: { total: number; rating_avg: number | null; negative_pct: number };
}
interface ReportListItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: ReportStatus;
  statusReason: string | null;
  createdAt: string;
  headline: string | null;
  total: number;
  createdByName: string | null;
}
interface ReportDetail extends Omit<ReportListItem, 'headline' | 'total'> {
  clientName: string;
  metrics: Metrics;
  summary: {
    headline: string;
    summary: string;
    findings: {
      kind: 'strength' | 'issue' | 'watch';
      topic: string;
      title: string;
      description: string;
      supportingInteractionIds: string[];
    }[];
    caveats: string[];
    provider: 'openai' | 'fake';
    model: string;
  } | null;
  warnings: string[];
  costUsd: string | null;
}

const STATUS_TONE: Record<ReportStatus, Tone> = {
  ready: 'success',
  metrics_only: 'neutral',
  insufficient_sample: 'warning',
  blocked: 'warning',
  failed: 'danger',
};
const KIND_TONE = { strength: 'success', issue: 'danger', watch: 'warning' } as const;
const PERIODS = [
  { days: 30, label: 'Últimos 30 días' },
  { days: 90, label: 'Últimos 90 días' },
  { days: 365, label: 'Último año' },
];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtNum = (n: number | null, digits = 1) =>
  n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: digits });
const fmtDate = (s: string) =>
  new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${s}T00:00:00Z`),
  );

function Delta({
  cur,
  prev,
  unit = '',
  invert = false,
}: {
  cur: number | null;
  prev: number | null;
  unit?: string;
  invert?: boolean;
}) {
  if (cur == null || prev == null) return null;
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return <span className="text-xs text-muted">igual que el periodo anterior</span>;
  const good = invert ? d < 0 : d > 0;
  return (
    <span className={good ? 'text-xs text-success' : 'text-xs text-danger'}>
      {d > 0 ? '+' : '−'}
      {fmtNum(Math.abs(d))}
      {unit} vs. periodo anterior
    </span>
  );
}

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** Métricas observadas: calculadas por el sistema, nunca por la IA. */
function MetricsView({ m }: { m: Metrics }) {
  const max = Math.max(1, ...Object.values(m.rating_distribution));
  return (
    <div className="space-y-6">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <BarChart3 className="size-3.5" aria-hidden /> Métricas observadas ·{' '}
        {fmtDate(m.period.from)} – {fmtDate(m.period.to)}
        {m.simulated > 0 && (
          <Badge tone="accent">
            {m.simulated === m.total ? 'Datos ficticios (simulador)' : `${m.simulated} ficticias`}
          </Badge>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Interacciones" value={fmtNum(m.total, 0)}>
          <Delta cur={m.total} prev={m.previous.total} />
        </Tile>
        <Tile label="Valoración media (de 5)" value={fmtNum(m.rating_avg)}>
          <Delta cur={m.rating_avg} prev={m.previous.rating_avg} />
        </Tile>
        <Tile label="Negativas o mixtas" value={`${m.negative_pct} %`}>
          <Delta cur={m.negative_pct} prev={m.previous.negative_pct} unit=" pp" invert />
        </Tile>
        <Tile label="Respondidas" value={`${m.response_rate_pct} %`}>
          <span className="text-xs text-muted">
            {m.median_response_hours != null
              ? `Mediana: ${fmtNum(m.median_response_hours)} h`
              : 'Sin tiempos de respuesta'}
          </span>
        </Tile>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium">Distribución de valoraciones</h3>
          <ul className="mt-3 space-y-1.5" aria-label="Distribución de valoraciones">
            {(['5', '4', '3', '2', '1'] as const).map((k) => {
              const n = m.rating_distribution[k];
              return (
                <li
                  key={k}
                  className="group flex items-center gap-2 text-sm"
                  title={`${k} ${k === '1' ? 'estrella' : 'estrellas'}: ${n}`}
                >
                  <span className="w-16 shrink-0 text-xs text-muted">
                    {k} {k === '1' ? 'estrella' : 'estrellas'}
                  </span>
                  <span className="relative h-3 flex-1 rounded bg-surface-2">
                    <span
                      className="absolute inset-y-0 left-0 rounded-r bg-accent group-hover:opacity-80"
                      style={{ width: `${(n / max) * 100}%` }}
                    />
                  </span>
                  <span className="w-8 shrink-0 text-right tabular-nums text-xs">{n}</span>
                </li>
              );
            })}
          </ul>
          {m.by_provider.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Por fuente:{' '}
              {m.by_provider
                .map((p) => `${PROVIDER_LABELS_ES[p.provider] ?? p.provider} ${p.count}`)
                .join(' · ')}
            </p>
          )}
        </div>
        <div>
          <h3 className="text-sm font-medium">Temas más mencionados</h3>
          {m.topics.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Sin temas detectados en el periodo.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1.5 font-normal">Tema</th>
                    <th className="py-1.5 text-right font-normal">Menciones</th>
                    <th className="py-1.5 text-right font-normal">Media</th>
                    <th className="py-1.5 text-right font-normal">Negativas</th>
                    <th className="py-1.5 text-right font-normal">Antes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {m.topics.map((t) => (
                    <tr key={t.topic}>
                      <td className="py-1.5">{t.topic}</td>
                      <td className="py-1.5 text-right tabular-nums">{t.count}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtNum(t.rating_avg)}</td>
                      <td className="py-1.5 text-right tabular-nums">{t.negative_pct} %</td>
                      <td className="py-1.5 text-right tabular-nums text-muted">
                        {t.previous_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {(m.risk_flagged > 0 || m.specialist_required > 0) && (
        <p className="flex items-center gap-1.5 text-sm text-warning">
          <AlertTriangle className="size-4" aria-hidden />
          {m.risk_flagged} con señales de riesgo · {m.specialist_required} requieren revisión
          especializada
        </p>
      )}
    </div>
  );
}

function ReportView({ id, orgId }: { id: string; orgId: string }) {
  const q = useQuery({
    queryKey: ['report', id],
    queryFn: () => api<ReportDetail>(`/reports/${id}`),
  });
  if (q.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  const s = r.summary;
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Informe de {r.clientName} · {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
          </h2>
          <Badge tone={STATUS_TONE[r.status]}>{REPORT_STATUS_LABELS_ES[r.status]}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted">
          Creado {fmtDateTime(r.createdAt)}
          {r.createdByName && ` por ${r.createdByName}`}
          {r.costUsd != null &&
            ` · coste de IA ${Number(r.costUsd).toLocaleString('es-ES', { maximumFractionDigits: 4 })} USD`}
        </p>
        {s ? (
          <section
            className="mt-4 rounded-lg border border-accent/30 bg-accent-soft/40 p-4"
            aria-label="Conclusión generada por IA"
          >
            <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-accent">
              <Bot className="size-3.5" aria-hidden /> Conclusión generada por IA (
              {s.provider === 'fake' ? 'IA simulada' : s.model}) a partir de las métricas observadas
            </p>
            <h3 className="mt-2 text-base font-semibold">{s.headline}</h3>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{s.summary}</p>
            {s.findings.length > 0 && (
              <ul className="mt-4 space-y-3">
                {s.findings.map((f) => (
                  <li key={f.title} className="rounded-md border border-border bg-surface p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={KIND_TONE[f.kind]}>{FINDING_KIND_LABELS_ES[f.kind]}</Badge>
                      <span className="text-sm font-medium">{f.title}</span>
                      <span className="text-xs text-muted">· tema «{f.topic}»</span>
                    </div>
                    <p className="mt-1 text-sm">{f.description}</p>
                    <p className="mt-1.5 text-xs text-muted">
                      Basado en {f.supportingInteractionIds.length} reseñas:{' '}
                      {f.supportingInteractionIds.map((iid, n) => (
                        <Link
                          key={iid}
                          to={`/o/${orgId}/bandeja/${iid}`}
                          className="mr-1.5 text-accent underline"
                        >
                          ver {n + 1}
                        </Link>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {s.caveats.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-xs text-muted">
                {s.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <p className="mt-4 rounded-lg bg-surface-2 p-3 text-sm text-muted">
            {r.statusReason ?? 'Sin resumen de IA.'}
          </p>
        )}
        {r.warnings.length > 0 && (
          <ul className="mt-3 space-y-0.5 text-xs text-warning">
            {r.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-5">
        <MetricsView m={r.metrics} />
      </Card>
    </div>
  );
}

export function ReportsPage() {
  const { orgId } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const clients = useQuery({
    queryKey: ['clients', orgId, 'all'],
    queryFn: () => api<Paginated<ClientListItem>>(`/organizations/${orgId}/clients?pageSize=100`),
  });
  const [clientId, setClientId] = useState('');
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!clientId && clients.data?.items[0]) setClientId(clients.data.items[0].id);
  }, [clients.data, clientId]);
  const to = iso(new Date());
  const from = iso(new Date(Date.now() - (days - 1) * 86_400_000));

  const insights = useQuery({
    queryKey: ['insights', clientId, from, to],
    queryFn: () =>
      api<{ metrics: Metrics; canCreateReport: boolean }>(
        `/clients/${clientId}/insights?from=${from}&to=${to}`,
      ),
    enabled: !!clientId,
  });
  const reports = useQuery({
    queryKey: ['reports', clientId],
    queryFn: () => api<ReportListItem[]>(`/clients/${clientId}/reports`),
    enabled: !!clientId,
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; status: ReportStatus }>(`/clients/${clientId}/reports`, {
        method: 'POST',
        body: { from, to },
      }),
    onSuccess: (r) => {
      toast('success', `Informe creado (${REPORT_STATUS_LABELS_ES[r.status]})`);
      setOpen(r.id);
      void qc.invalidateQueries({ queryKey: ['reports', clientId] });
    },
    onError: (e: Error) => toast('error', e.message),
  });

  if (clients.isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (clients.isError)
    return <ErrorState error={clients.error} onRetry={() => clients.refetch()} />;
  if (!clients.data?.items.length) {
    return (
      <>
        <PageHeader title="Informes" />
        <Card>
          <EmptyState
            title="Sin clientes"
            description="Da de alta un cliente para ver sus métricas."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Informes"
        description="Métricas observadas por el sistema y, por separado, conclusiones redactadas por IA."
      />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Cliente" className="min-w-56">
          {(p) => (
            <Select
              {...p}
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setOpen(null);
              }}
            >
              {clients.data.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Periodo">
          {(p) => (
            <Select {...p} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {PERIODS.map((x) => (
                <option key={x.days} value={x.days}>
                  {x.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {insights.data?.canCreateReport && (
          <Button onClick={() => create.mutate()} loading={create.isPending}>
            <FileText className="size-4" aria-hidden /> Crear informe con resumen IA
          </Button>
        )}
        {create.isPending && (
          <span className="text-xs text-muted" role="status">
            Calculando y redactando…
          </span>
        )}
      </div>

      {open ? (
        <>
          <Button variant="ghost" size="sm" className="mb-3" onClick={() => setOpen(null)}>
            ← Volver a las métricas
          </Button>
          <ReportView id={open} orgId={orgId} />
        </>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="p-5 lg:col-span-2">
            {!insights.data && !insights.isError ? (
              <Skeleton className="h-64 rounded-lg" />
            ) : insights.isError ? (
              <ErrorState error={insights.error} onRetry={() => insights.refetch()} />
            ) : insights.data!.metrics.total === 0 ? (
              <EmptyState
                title="Sin interacciones en el periodo"
                description="Prueba con un periodo más largo."
              />
            ) : (
              <MetricsView m={insights.data!.metrics} />
            )}
          </Card>
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Informes guardados</h2>
            {reports.data && reports.data.length === 0 && (
              <p className="mt-2 text-sm text-muted">Todavía no hay informes de este cliente.</p>
            )}
            <ul className="mt-2 space-y-2">
              {reports.data?.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(r.id)}
                    className="w-full rounded-md border border-border p-2.5 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-medium">
                        {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}
                      </span>
                      <Badge tone={STATUS_TONE[r.status]}>
                        {REPORT_STATUS_LABELS_ES[r.status]}
                      </Badge>
                    </span>
                    {r.headline && <span className="mt-1 block text-xs">{r.headline}</span>}
                    <span className="mt-0.5 block text-xs text-muted">
                      {r.total} interacciones · {fmtDateTime(r.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
