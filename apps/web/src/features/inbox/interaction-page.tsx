import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  RotateCcw,
  Send,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { Member } from '@/lib/types';
import {
  EVENT_LABELS,
  JOB_STATUS,
  connectionLabel,
  fmtDateTime,
  providerLabel,
  stateLabel,
  type InteractionDetail,
} from '@/lib/inbox';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Select, Switch, Textarea } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { PriorityBadge, RiskBadges, SimulatedBadge, Stars, StateBadge } from './parts';
import { ApprovalPanel } from './approval-panel';

const OUTCOME_LABELS: Record<string, string> = {
  published: 'publicada',
  not_found: 'no encontrada en la fuente',
  failed: 'error',
  ambiguous: 'respuesta ambigua',
  blocked: 'en pausa por interruptor',
};

const EDITABLE = [
  'new',
  'analyzed',
  'pending_response',
  'draft_generated',
  'pending_approval',
  'approved',
  'publish_failed',
];

export function InteractionPage() {
  const { orgId } = useOrg();
  const { interactionId } = useParams<{ interactionId: string }>();
  const id = interactionId!;
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['interaction', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<InteractionDetail>(`/interactions/${id}`),
    // Mientras se publica, refresca para mostrar el resultado sin recargar.
    refetchInterval: (query) =>
      ['approved', 'publishing'].includes(query.state.data?.interaction.state ?? '') ? 2500 : false,
  });
  const members = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api<Member[]>(`/organizations/${orgId}/members`),
  });

  const latest = q.data?.drafts[0];
  const [text, setText] = useState('');
  const [confirmAction, setConfirmAction] = useState<'discard' | 'close_without_response' | null>(
    null,
  );
  useEffect(() => {
    setText(latest?.content ?? '');
  }, [latest?.id, latest?.content]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['inbox', orgId] });
    void qc.invalidateQueries({ queryKey: ['approvals', orgId] });
  };
  const onError = (e: Error) => toast('error', e.message);

  const saveDraft = useMutation({
    mutationFn: () =>
      api(`/interactions/${id}/drafts`, { method: 'POST', body: { content: text } }),
    onSuccess: () => {
      toast('success', 'Borrador guardado');
      refresh();
    },
    onError,
  });
  const requestApproval = useMutation({
    mutationFn: () => api(`/interactions/${id}/request-approval`, { method: 'POST' }),
    onSuccess: () => {
      toast('success', 'Enviada a aprobación');
      refresh();
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/interactions/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError,
  });
  const action = useMutation({
    mutationFn: (a: string) =>
      api(`/interactions/${id}/actions`, { method: 'POST', body: { action: a } }),
    onSuccess: () => {
      setConfirmAction(null);
      refresh();
    },
    onError,
  });

  if (q.isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return <ErrorState error={new Error('Esta interacción no existe o no tienes acceso.')} />;
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  const d = q.data!;
  const i = d.interaction;
  const p = d.permissions;
  const dirty = text.trim() !== (latest?.content ?? '');
  const editable = EDITABLE.includes(i.state);
  const invalidatesApproval = ['pending_approval', 'approved', 'publish_failed'].includes(i.state);
  const lastJob = d.jobs[0];
  const lastDecision = d.approvals[0];

  return (
    <>
      <Link
        to={`/o/${orgId}/bandeja`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden /> Bandeja
      </Link>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Interacción original */}
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold">{i.authorDisplayName ?? 'Autor anónimo'}</h1>
              <Stars rating={i.rating} scale={i.ratingScale} />
              {i.isSimulated && <SimulatedBadge />}
            </div>
            <p className="mt-1 text-sm text-muted">
              {i.clientName}
              {i.locationName && ` · ${i.locationName}`} · {providerLabel(i.provider)} ·{' '}
              {fmtDateTime(i.originalCreatedAt)}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <StateBadge state={i.state} />
              <PriorityBadge priority={i.priority} />
              <RiskBadges flags={i.riskFlags} />
              {i.requiresSpecialist && (
                <Badge tone="danger">
                  <ShieldAlert className="size-3" aria-hidden /> Requiere revisión especializada
                </Badge>
              )}
            </div>
            <blockquote className="mt-4 whitespace-pre-wrap rounded-lg bg-surface-2 p-4 text-[15px] leading-relaxed">
              {i.content ?? <span className="italic text-muted">Valoración sin texto</span>}
            </blockquote>
            {i.riskFlags.includes('prompt_injection') && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                El texto contiene instrucciones dirigidas a sistemas automáticos. Se trata como
                contenido del cliente y no se ejecuta.
              </p>
            )}
            {d.versions.length > 1 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted">
                  El autor ha editado esta reseña ({d.versions.length} versiones)
                </summary>
                <ol className="mt-2 space-y-2">
                  {d.versions.map((v) => (
                    <li key={v.id} className="rounded-md border border-border p-2">
                      <p className="text-xs text-muted">{fmtDateTime(v.observedAt)}</p>
                      <p>{v.content ?? '—'}</p>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {i.url && (
              <a
                href={i.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline"
              >
                Ver en {providerLabel(i.provider)} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </Card>

          {/* Respuesta */}
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Respuesta</h2>

            {i.state === 'published' ? (
              <div className="mt-3">
                <p className="flex items-center gap-1.5 text-sm text-success">
                  <CheckCircle2 className="size-4" aria-hidden /> Publicada y verificada en{' '}
                  {providerLabel(i.provider)} · {fmtDateTime(i.respondedAt)}
                </p>
                <p className="mt-3 whitespace-pre-wrap rounded-lg border border-border p-4 text-sm">
                  {i.existingReplyContent ?? latest?.content}
                </p>
              </div>
            ) : (
              <>
                {i.existingReplyContent && (
                  <div className="mt-3 rounded-lg border border-border p-3 text-sm">
                    <p className="text-xs text-muted">Respuesta ya visible en la fuente</p>
                    <p className="mt-1 whitespace-pre-wrap">{i.existingReplyContent}</p>
                  </div>
                )}
                {lastDecision &&
                  lastDecision.decision !== 'approved' &&
                  i.state === 'draft_generated' && (
                    <div className="mt-3 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
                      {lastDecision.decision === 'rejected' ? 'Rechazada' : 'Devuelta'} por{' '}
                      {lastDecision.decidedByName ?? 'un aprobador'}: {lastDecision.note}
                    </div>
                  )}
                {i.state === 'publish_failed' && lastJob && (
                  <div
                    role="alert"
                    className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger"
                  >
                    <AlertTriangle className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1">
                      No se pudo publicar: {lastJob.lastErrorMessage ?? 'error desconocido'}
                      {lastJob.status === 'queued' && ' · Se reintentará automáticamente.'}
                    </span>
                    {p.canRetryPublish && lastJob.status === 'failed' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => action.mutate('retry_publish')}
                        loading={action.isPending}
                      >
                        <RotateCcw className="size-3.5" aria-hidden /> Reintentar
                      </Button>
                    )}
                  </div>
                )}
                {(i.state === 'approved' || i.state === 'publishing') && (
                  <p
                    className="mt-3 rounded-lg bg-accent-soft p-3 text-sm text-accent"
                    role="status"
                  >
                    {lastJob?.lastErrorKind === 'paused'
                      ? `Aprobada. Publicación en espera: ${lastJob.lastErrorMessage}`
                      : 'Aprobada. Publicando y verificando…'}
                  </p>
                )}

                {p.canDraft && editable ? (
                  <div className="mt-4">
                    <Field
                      label={latest ? `Borrador (versión ${latest.version})` : 'Borrador'}
                      hint={`${text.length}/5000 caracteres`}
                    >
                      {(f) => (
                        <Textarea
                          {...f}
                          value={text}
                          maxLength={5000}
                          rows={6}
                          onChange={(e) => setText(e.target.value)}
                          placeholder="Escribe la respuesta que se publicará…"
                        />
                      )}
                    </Field>
                    {dirty && invalidatesApproval && (
                      <p className="mt-2 text-xs text-warning">
                        Guardar cambios invalidará la{' '}
                        {i.state === 'pending_approval' ? 'solicitud de aprobación' : 'aprobación'}{' '}
                        y habrá que volver a solicitarla.
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        onClick={() => saveDraft.mutate()}
                        loading={saveDraft.isPending}
                        disabled={!dirty || !text.trim()}
                        variant="secondary"
                      >
                        Guardar borrador
                      </Button>
                      {p.canRequestApproval && i.state === 'draft_generated' && latest && (
                        <Button
                          onClick={() => requestApproval.mutate()}
                          loading={requestApproval.isPending}
                          disabled={dirty}
                        >
                          <Send className="size-4" aria-hidden /> Enviar a aprobación
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled
                        title="Disponible en la Fase 3 (requiere clave de OpenAI)"
                      >
                        <Sparkles className="size-4" aria-hidden /> Generar con IA · Fase 3
                      </Button>
                    </div>
                  </div>
                ) : (
                  latest && (
                    <p className="mt-3 whitespace-pre-wrap rounded-lg border border-border p-4 text-sm">
                      {latest.content}
                    </p>
                  )
                )}
                {!latest && !p.canDraft && (
                  <p className="mt-3 text-sm text-muted">Todavía no hay borrador.</p>
                )}
              </>
            )}
          </Card>

          {i.state === 'pending_approval' && p.canApprove && latest && (
            <ApprovalPanel
              interactionId={id}
              draft={latest}
              requiresSpecialist={i.requiresSpecialist}
              isSimulated={i.isSimulated}
              provider={i.provider}
              onDone={refresh}
            />
          )}

          {/* Historial */}
          <Card>
            <h2 className="border-b border-border px-5 py-3.5 text-sm font-semibold">Historial</h2>
            <ol className="divide-y divide-border">
              {d.events.map((e) => (
                <li key={e.id} className="px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                    <time className="text-xs text-muted" dateTime={e.createdAt}>
                      {fmtDateTime(e.createdAt)}
                    </time>
                  </div>
                  <p className="text-xs text-muted">
                    {e.actorType === 'system'
                      ? 'Sistema'
                      : (e.actorName ?? e.actorEmail ?? 'Usuario')}
                    {e.fromState &&
                      e.toState &&
                      e.fromState !== e.toState &&
                      ` · ${stateLabel(e.fromState)} → ${stateLabel(e.toState)}`}
                    {typeof e.data.note === 'string' && e.data.note && ` · «${e.data.note}»`}
                    {e.data.reason === 'source_changed' && ' · la reseña cambió en la fuente'}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        {/* Lateral */}
        <div className="space-y-6">
          <Card className="space-y-4 p-5">
            <h2 className="text-sm font-semibold">Gestión</h2>
            <Field label="Asignada a">
              {(f) => (
                <Select
                  {...f}
                  value={i.assigneeId ?? ''}
                  disabled={!p.canUpdate || patch.isPending}
                  onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })}
                >
                  <option value="">Sin asignar</option>
                  {members.data
                    ?.filter((m) => m.status === 'active')
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.fullName ?? m.email}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="Prioridad">
              {(f) => (
                <Select
                  {...f}
                  value={String(i.priority)}
                  disabled={!p.canUpdate || patch.isPending}
                  onChange={(e) => patch.mutate({ priority: Number(e.target.value) })}
                >
                  <option value="1">Baja</option>
                  <option value="2">Normal</option>
                  <option value="3">Alta</option>
                  <option value="4">Crítica</option>
                </Select>
              )}
            </Field>
            <Switch
              label="Revisión especializada"
              description="Obliga al aprobador a confirmar una revisión adicional (legal, salud…)."
              checked={i.requiresSpecialist}
              disabled={!p.canUpdate || patch.isPending}
              onChange={(v) => patch.mutate({ requiresSpecialist: v })}
            />
            {p.canUpdate && i.state !== 'published' && i.state !== 'publishing' && (
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {['new', 'analyzed'].includes(i.state) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => action.mutate('mark_needs_response')}
                  >
                    Marcar pendiente
                  </Button>
                )}
                {['new', 'analyzed', 'pending_response', 'draft_generated'].includes(i.state) && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setConfirmAction('close_without_response')}
                  >
                    Cerrar sin respuesta
                  </Button>
                )}
                {EDITABLE.includes(i.state) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => setConfirmAction('discard')}
                  >
                    Descartar
                  </Button>
                )}
                {['discarded', 'closed_no_response'].includes(i.state) && (
                  <Button size="sm" variant="secondary" onClick={() => action.mutate('reopen')}>
                    Reabrir
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card className="p-5 text-sm">
            <h2 className="font-semibold">Fuente</h2>
            <dl className="mt-3 space-y-2">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Cuenta</dt>
                <dd className="text-right">{i.accountName ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Estado</dt>
                <dd>{i.accountStatus ? connectionLabel(i.accountStatus) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Detectada</dt>
                <dd>{fmtDateTime(i.firstSeenAt)}</dd>
              </div>
            </dl>
          </Card>

          {d.jobs.length > 0 && (
            <Card className="p-5 text-sm">
              <h2 className="font-semibold">Publicaciones</h2>
              <ul className="mt-3 space-y-3">
                {d.jobs.map((j) => (
                  <li key={j.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between">
                      <Badge tone={JOB_STATUS[j.status]?.tone ?? 'neutral'}>
                        {JOB_STATUS[j.status]?.label ?? j.status}
                      </Badge>
                      <span className="text-xs text-muted">{j.attempts} intento(s)</span>
                    </div>
                    {j.lastErrorMessage && (
                      <p className="mt-2 text-xs text-muted">{j.lastErrorMessage}</p>
                    )}
                    <ul className="mt-2 space-y-1 text-xs text-muted">
                      {d.attempts
                        .filter((a) => a.jobId === j.id)
                        .map((a) => (
                          <li key={a.id}>
                            {fmtDateTime(a.startedAt)} ·{' '}
                            {a.operation === 'status_check' ? 'consulta de estado' : 'publicación'}{' '}
                            · {OUTCOME_LABELS[a.outcome ?? ''] ?? a.outcome ?? 'en curso'}
                          </li>
                        ))}
                    </ul>
                    {d.receipts.find((r) => r.id && j.status === 'published') && (
                      <p className="mt-2 text-xs text-success">
                        Verificada · id externo {j.externalReplyId ?? '—'}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
        title={
          confirmAction === 'discard' ? '¿Descartar esta interacción?' : '¿Cerrar sin responder?'
        }
        description="Se cancelará cualquier publicación pendiente. Podrás reabrirla más tarde."
        confirmLabel={confirmAction === 'discard' ? 'Descartar' : 'Cerrar'}
        danger={confirmAction === 'discard'}
        loading={action.isPending}
        onConfirm={() => confirmAction && action.mutate(confirmAction)}
      />
    </>
  );
}
