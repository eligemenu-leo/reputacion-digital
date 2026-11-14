import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, Bot, RotateCcw, Sparkles } from 'lucide-react';
import {
  AI_DRAFT_VARIANT_LABELS_ES,
  AI_STATUS_LABELS_ES,
  CATEGORY_LABELS_ES,
  confidenceLabel,
  type AiDraftVariant,
} from '@rep/shared';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { Draft, InteractionDetail } from '@/lib/inbox';
import { Badge, Card } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { SentimentBadge } from './parts';

/** Etiqueta que distingue el modelo real del simulado de desarrollo. */
export function AiBadge({ provider, model }: { provider: 'openai' | 'fake'; model?: string }) {
  return (
    <Badge tone={provider === 'fake' ? 'warning' : 'accent'}>
      <Bot className="size-3" aria-hidden />
      {provider === 'fake' ? 'IA simulada' : 'IA'}
      {model && <span className="sr-only"> · {model}</span>}
    </Badge>
  );
}

/** Resultado de la clasificación automática (lateral de la ficha). */
export function AiAnalysisCard({
  detail,
  onChanged,
}: {
  detail: InteractionDetail;
  onChanged: () => void;
}) {
  const toast = useToast();
  const i = detail.interaction;
  const c = detail.classification;
  const retry = useMutation({
    mutationFn: () => api(`/interactions/${i.id}/ai-classify`, { method: 'POST' }),
    onSuccess: () => {
      toast('success', 'Análisis solicitado');
      onChanged();
    },
    onError: (e: Error) => toast('error', e.message),
  });
  const conf = confidenceLabel(i.aiConfidence == null ? null : Number(i.aiConfidence));
  const busy = i.aiStatus === 'pending' || i.aiStatus === 'running';

  return (
    <Card className="space-y-3 p-5" aria-busy={busy}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Análisis</h2>
        {c && <AiBadge provider={c.provider} model={c.model} />}
      </div>
      {i.aiStatus === 'done' && c ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">Sentimiento</dt>
            <dd>
              <SentimentBadge sentiment={i.sentiment} />
            </dd>
            <dt className="text-muted">Tipo</dt>
            <dd>{i.category ? CATEGORY_LABELS_ES[i.category] : '—'}</dd>
            {i.topics.length > 0 && (
              <>
                <dt className="text-muted">Temas</dt>
                <dd className="flex flex-wrap gap-1">
                  {i.topics.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </dd>
              </>
            )}
            <dt className="text-muted">Confianza</dt>
            <dd title="Estimación del propio modelo, no una probabilidad calibrada">
              {conf ?? '—'} <span className="text-xs text-muted">(estimada por la IA)</span>
            </dd>
            {i.requiresResponse === false && (
              <>
                <dt className="text-muted">Respuesta</dt>
                <dd>La IA sugiere que no hace falta responder</dd>
              </>
            )}
          </dl>
          {c.rationale && (
            <p className="rounded-md bg-surface-2 p-2.5 text-xs text-muted">
              <span className="font-medium text-fg">Motivo: </span>
              {c.rationale}
            </p>
          )}
          <p className="text-xs text-muted">
            Conclusión generada por IA ({c.model}). La prioridad y las alertas también aplican
            reglas fijas y nunca bajan por la IA.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted" role="status">
          {AI_STATUS_LABELS_ES[i.aiStatus]}
          {i.aiError && <span className="mt-1 block text-xs text-warning">{i.aiError}</span>}
          {!detail.ai.configured && i.aiStatus === 'not_requested' && (
            <span className="mt-1 block text-xs">La IA no está configurada en este entorno.</span>
          )}
        </p>
      )}
      {detail.permissions.canUpdate && detail.ai.configured && !busy && (
        <Button size="sm" variant="ghost" onClick={() => retry.mutate()} loading={retry.isPending}>
          <RotateCcw className="size-3.5" aria-hidden />
          {i.aiStatus === 'done' ? 'Volver a analizar' : 'Analizar con IA'}
        </Button>
      )}
    </Card>
  );
}

interface AiDraftResponse {
  draft: { id: string; version: number; content: string };
  unchanged: boolean;
  generation: { warnings: string[] };
}

/** Botones «Generar con IA» y variantes. El resultado es un borrador más: sigue necesitando aprobación. */
export function AiDraftActions({
  detail,
  latest,
  dirty,
  onGenerated,
}: {
  detail: InteractionDetail;
  latest: Draft | undefined;
  dirty: boolean;
  onGenerated: () => void;
}) {
  const toast = useToast();
  const { orgId } = useOrg();
  const i = detail.interaction;
  const [blocked, setBlocked] = useState<{
    message: string;
    reason?: string;
    reasons?: string[];
  } | null>(null);
  const gen = useMutation({
    mutationFn: (variant: AiDraftVariant) =>
      api<AiDraftResponse>(`/interactions/${i.id}/ai-draft`, { method: 'POST', body: { variant } }),
    onSuccess: (r) => {
      setBlocked(null);
      toast(
        'success',
        r.unchanged
          ? 'La IA propuso el mismo texto'
          : 'Borrador generado: revísalo antes de enviarlo',
      );
      onGenerated();
    },
    onError: (e: Error) => {
      const det =
        e instanceof ApiError
          ? (e.details as { reason?: string; reasons?: string[] } | undefined)
          : undefined;
      setBlocked({ message: e.message, reason: det?.reason, reasons: det?.reasons });
    },
  });

  if (!detail.ai.configured) {
    return (
      <Button variant="ghost" disabled title="La IA no está configurada en este entorno">
        <Sparkles className="size-4" aria-hidden /> Generar con IA (no configurada)
      </Button>
    );
  }
  if (!i.clientAiEnabled) {
    return (
      <Button variant="ghost" disabled title="La IA está desactivada para este cliente">
        <Sparkles className="size-4" aria-hidden /> IA desactivada para el cliente
      </Button>
    );
  }
  const variants: AiDraftVariant[] = latest
    ? ['another', 'shorter', 'warmer', 'more_formal']
    : ['initial'];
  const confirmIfDirty = () =>
    !dirty ||
    window.confirm(
      'Tienes cambios sin guardar en el borrador. ¿Quieres descartarlos y generar uno nuevo?',
    );

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {variants.map((v) => (
          <Button
            key={v}
            size="sm"
            variant={v === 'initial' ? 'secondary' : 'ghost'}
            loading={gen.isPending && gen.variables === v}
            disabled={gen.isPending}
            onClick={() => confirmIfDirty() && gen.mutate(v)}
          >
            {v === 'initial' && <Sparkles className="size-4" aria-hidden />}
            {AI_DRAFT_VARIANT_LABELS_ES[v]}
          </Button>
        ))}
        {gen.isPending && (
          <span className="text-xs text-muted" role="status">
            La IA está redactando…
          </span>
        )}
      </div>
      {blocked && (
        <div
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning"
        >
          <p className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{blocked.message}</span>
          </p>
          {blocked.reasons && blocked.reasons.length > 0 && (
            <ul className="mt-1 list-disc pl-6 text-xs">
              {blocked.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {blocked.reason === 'brand_profile_missing' && (
            <Link
              to={`/o/${orgId}/clientes/${i.clientId}#marca`}
              className="mt-1 inline-block text-xs underline"
            >
              Configurar la personalidad de marca de {i.clientName}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** Avisos y trazabilidad de un borrador generado por IA. */
export function AiDraftNotice({ draft }: { draft: Partial<Pick<Draft, 'ai'>> }) {
  if (!draft.ai) return null;
  const a = draft.ai;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface-2 p-3 text-xs">
      <p className="flex flex-wrap items-center gap-1.5 text-muted">
        <AiBadge provider={a.provider} model={a.model} />
        Propuesta generada por IA ({a.model}). Revísala: no se publica sin aprobación.
        {a.toneApplied && <span>· Tono: {a.toneApplied}</span>}
      </p>
      {a.warnings.length > 0 && (
        <ul className="space-y-0.5 text-warning">
          {a.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}
      {a.usedFacts && a.usedFacts.length > 0 && (
        <p className="text-muted">Datos verificados usados: {a.usedFacts.join(', ')}</p>
      )}
    </div>
  );
}
