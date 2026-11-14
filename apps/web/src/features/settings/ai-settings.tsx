import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input, Switch } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

interface AiStatusResponse {
  configured: boolean;
  provider: 'openai' | 'fake' | null;
  models: { classify: string; draft: string } | null;
  realDataAllowed: boolean;
  budget: { limitUsd: number; hardStop: boolean; spentUsd: number; calls: number };
  usage: { kind: 'classification' | 'draft'; calls: number; costUsd: number }[];
  canManage: boolean;
}

const usd = (n: number) =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`;

/** Estado de la IA, consumo del mes y presupuesto con corte automático. */
export function AiSettings({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['ai-status', orgId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<AiStatusResponse>(`/organizations/${orgId}/ai`),
  });
  const [limit, setLimit] = useState('');
  const [hardStop, setHardStop] = useState(true);
  useEffect(() => {
    if (q.data) {
      setLimit(String(q.data.budget.limitUsd));
      setHardStop(q.data.budget.hardStop);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api(`/organizations/${orgId}/ai/budget`, {
        method: 'PATCH',
        body: { monthlyLimitUsd: Number(limit), hardStop },
      }),
    onSuccess: () => {
      toast('success', 'Presupuesto de IA guardado');
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast('error', e.message),
  });

  if (q.isLoading) return <Skeleton className="h-48 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const pct =
    d.budget.limitUsd > 0 ? Math.min(100, (d.budget.spentUsd / d.budget.limitUsd) * 100) : 100;
  const used = (k: 'classification' | 'draft') => d.usage.find((u) => u.kind === k);

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Bot className="size-4" aria-hidden /> Inteligencia artificial
        </h2>
        {d.configured ? (
          <Badge tone={d.provider === 'fake' ? 'warning' : 'success'}>
            {d.provider === 'fake' ? 'IA simulada (desarrollo)' : 'OpenAI conectado'}
          </Badge>
        ) : (
          <Badge tone="neutral">No configurada</Badge>
        )}
      </div>
      {d.models && (
        <p className="mt-2 text-sm text-muted">
          Clasificación: {d.models.classify} · Redacción: {d.models.draft}
        </p>
      )}
      {!d.realDataAllowed && (
        <p className="mt-2 rounded-md bg-warning-soft p-2.5 text-xs text-warning">
          Hasta firmar el acuerdo de tratamiento de datos (DPA) con el proveedor, la IA solo procesa
          reseñas ficticias del simulador.
        </p>
      )}
      <div className="mt-4">
        <div className="flex items-baseline justify-between text-sm">
          <span>Consumo de este mes</span>
          <span className="tabular-nums">
            {usd(d.budget.spentUsd)} de {usd(d.budget.limitUsd)}
          </span>
        </div>
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label="Presupuesto de IA consumido"
        >
          <div
            className={pct >= 90 ? 'h-full bg-danger' : 'h-full bg-accent'}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {used('classification')?.calls ?? 0} análisis · {used('draft')?.calls ?? 0} borradores. El
          coste se calcula con los tokens que informa el proveedor; OpenAI factura en dólares.
        </p>
      </div>
      {d.canManage && (
        <form
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Presupuesto mensual (USD)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="0.5"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            )}
          </Field>
          <div className="flex items-end">
            <Switch
              checked={hardStop}
              onChange={setHardStop}
              label="Detener la IA al llegar al límite"
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" variant="secondary" loading={save.isPending}>
              Guardar presupuesto
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
