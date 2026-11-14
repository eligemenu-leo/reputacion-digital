/**
 * Flujo de trabajo de una interacción: estados, borradores, aprobaciones y
 * creación del trabajo de publicación.
 *
 * Todas las funciones reciben una transacción ya ELEVADA a service_role (tras
 * comprobar permisos en la ruta) y la interacción bloqueada con FOR UPDATE.
 * La base de datos vuelve a validar las transiciones y la correspondencia
 * aprobación ↔ texto publicado, así que un error aquí no puede publicar nada
 * que no esté aprobado.
 */
import {
  AppError,
  nextInteractionState,
  responseHash,
  type InteractionEvent,
  type InteractionState,
} from '@rep/shared';
import type { Tx } from '../lib/db';

export interface Actor {
  userId: string | null;
  requestId?: string;
}

export interface InteractionRow {
  id: string;
  organizationId: string;
  clientId: string;
  connectedAccountId: string | null;
  provider: string;
  state: InteractionState;
  requiresSpecialist: boolean;
  assigneeId: string | null;
  priority: number;
}

const ROW_COLS = `id, organization_id, client_id, connected_account_id, provider, state, requires_specialist, assignee_id, priority`;

export async function lockInteraction(tx: Tx, id: string): Promise<InteractionRow> {
  const [row] = await tx<InteractionRow[]>`
    select ${tx.unsafe(ROW_COLS)} from public.external_interactions where id = ${id} for update`;
  if (!row) throw new AppError('NOT_FOUND', 'Interacción no encontrada');
  return row;
}

export async function recordEvent(
  tx: Tx,
  i: Pick<InteractionRow, 'id' | 'organizationId' | 'clientId'>,
  eventType: string,
  actor: Actor,
  extra: { from?: InteractionState; to?: InteractionState; data?: Record<string, unknown> } = {},
) {
  await tx`
    insert into public.interaction_events
      (organization_id, client_id, interaction_id, event_type, from_state, to_state, actor_user_id, actor_type, data)
    values (${i.organizationId}, ${i.clientId}, ${i.id}, ${eventType}, ${extra.from ?? null}, ${extra.to ?? null},
            ${actor.userId}, ${actor.userId ? 'user' : 'system'}, ${tx.json((extra.data ?? {}) as never)})`;
}

export async function audit(
  tx: Tx,
  entry: {
    organizationId: string;
    clientId?: string | null;
    actor: Actor;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await tx`
    insert into public.audit_logs (organization_id, client_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata, request_id)
    values (${entry.organizationId}, ${entry.clientId ?? null}, ${entry.actor.userId}, ${entry.actor.userId ? 'user' : 'system'},
            ${entry.action}, ${entry.entityType}, ${entry.entityId}, ${tx.json((entry.metadata ?? {}) as never)}, ${entry.actor.requestId ?? null})`;
}

/** Aplica un evento de la máquina de estados; lanza CONFLICT si no es válido desde el estado actual. */
export async function transition(
  tx: Tx,
  i: InteractionRow,
  event: InteractionEvent,
  actor: Actor,
  data: Record<string, unknown> = {},
  extraSet: Record<string, unknown> = {},
): Promise<InteractionState> {
  const to = nextInteractionState(i.state, event);
  if (!to) {
    throw new AppError('CONFLICT', 'La acción no está permitida en el estado actual', {
      state: i.state,
      event,
    });
  }
  const set = { state: to, ...extraSet };
  await tx`update public.external_interactions set ${tx(set as unknown as Record<string, never>)} where id = ${i.id}`;
  await recordEvent(tx, i, event, actor, { from: i.state, to, data });
  i.state = to;
  return to;
}

/** Cancela trabajos de publicación que aún no han empezado (p. ej. al editar el texto). */
async function cancelPendingJobs(tx: Tx, interactionId: string): Promise<number> {
  const r = await tx`
    update public.publication_jobs set status = 'cancelled', completed_at = now()
     where interaction_id = ${interactionId} and status in ('queued', 'failed') returning id`;
  return r.length;
}

export async function latestDraft(tx: Tx, interactionId: string) {
  const [d] = await tx<{ id: string; version: number; content: string; contentHash: string }[]>`
    select id, version, content, content_hash from public.response_drafts
     where interaction_id = ${interactionId} order by version desc limit 1`;
  return d ?? null;
}

/**
 * Guarda una nueva versión del borrador. Si había una aprobación o una
 * solicitud en curso, queda invalidada (el estado vuelve a «borrador») y se
 * cancelan las publicaciones pendientes.
 */
export async function saveDraft(
  tx: Tx,
  i: InteractionRow,
  content: string,
  actor: Actor,
  source: 'human' | 'ai' = 'human',
  aiGenerationId: string | null = null,
) {
  if (i.state === 'publishing' || i.state === 'published') {
    throw new AppError('CONFLICT', 'La respuesta ya se está publicando o está publicada');
  }
  if (i.state === 'discarded' || i.state === 'closed_no_response') {
    throw new AppError('CONFLICT', 'Reabre la interacción antes de redactar una respuesta');
  }
  const prev = await latestDraft(tx, i.id);
  const hash = await responseHash(content);
  if (prev && prev.contentHash === hash) {
    return { draft: prev, unchanged: true };
  }
  const version = (prev?.version ?? 0) + 1;
  const [draft] = await tx<{ id: string; version: number; content: string; contentHash: string }[]>`
    insert into public.response_drafts (organization_id, client_id, interaction_id, version, content, content_hash, source, ai_generation_id, created_by)
    values (${i.organizationId}, ${i.clientId}, ${i.id}, ${version}, ${content}, ${hash}, ${source}, ${aiGenerationId}, ${actor.userId})
    returning id, version, content, content_hash`;
  const invalidates =
    i.state === 'pending_approval' || i.state === 'approved' || i.state === 'publish_failed';
  const ev: InteractionEvent =
    i.state === 'new' || i.state === 'analyzed' || i.state === 'pending_response'
      ? 'draft_saved'
      : 'draft_edited';
  const cancelled = invalidates ? await cancelPendingJobs(tx, i.id) : 0;
  await transition(
    tx,
    i,
    ev,
    actor,
    {
      draftId: draft!.id,
      version,
      source,
      invalidatedApproval: invalidates,
      cancelledJobs: cancelled,
    },
    invalidates ? { approvalRequestedBy: null, approvalRequestedAt: null } : {},
  );
  return { draft: draft!, unchanged: false };
}

export async function requestApproval(tx: Tx, i: InteractionRow, actor: Actor) {
  const d = await latestDraft(tx, i.id);
  if (!d) throw new AppError('CONFLICT', 'No hay borrador que enviar a aprobación');
  await transition(
    tx,
    i,
    'request_approval',
    actor,
    { draftId: d.id, version: d.version, contentHash: d.contentHash },
    {
      approvalRequestedBy: actor.userId,
      approvalRequestedAt: new Date(),
    },
  );
  return d;
}

export interface DecisionInput {
  decision: 'approve' | 'reject' | 'return';
  note?: string;
  specialistReviewed: boolean;
  contentHash: string;
}

/**
 * Registra la decisión del aprobador sobre el texto EXACTO que ha visto
 * (contentHash). Si se aprueba, crea el trabajo de publicación en la misma
 * transacción; el aviso a la cola se envía tras el commit.
 */
export async function decide(tx: Tx, i: InteractionRow, input: DecisionInput, actor: Actor) {
  if (!actor.userId) throw new AppError('FORBIDDEN', 'Las aprobaciones requieren una persona');
  if (i.state !== 'pending_approval') {
    throw new AppError('CONFLICT', 'La respuesta no está pendiente de aprobación', {
      state: i.state,
    });
  }
  const d = await latestDraft(tx, i.id);
  if (!d || d.contentHash !== input.contentHash) {
    throw new AppError(
      'CONFLICT',
      'El texto ha cambiado desde que lo abriste. Revisa la versión actual.',
      {
        reason: 'stale_content',
      },
    );
  }
  if (input.decision === 'approve' && i.requiresSpecialist && !input.specialistReviewed) {
    throw new AppError(
      'VALIDATION',
      'Esta interacción requiere confirmar la revisión especializada antes de aprobar',
      {
        reason: 'specialist_required',
      },
    );
  }
  if (input.decision !== 'approve' && !input.note) {
    throw new AppError('VALIDATION', 'Indica el motivo para rechazar o devolver la respuesta');
  }
  const dbDecision = { approve: 'approved', reject: 'rejected', return: 'returned' }[
    input.decision
  ];
  const [approval] = await tx<{ id: string }[]>`
    insert into public.response_approvals
      (organization_id, client_id, interaction_id, draft_id, content_hash, decision, note, specialist_reviewed, decided_by)
    values (${i.organizationId}, ${i.clientId}, ${i.id}, ${d.id}, ${d.contentHash}, ${dbDecision}, ${input.note ?? null},
            ${input.specialistReviewed}, ${actor.userId})
    returning id`;
  const event: InteractionEvent =
    input.decision === 'approve'
      ? 'approve'
      : input.decision === 'reject'
        ? 'reject'
        : 'return_to_manager';
  await transition(tx, i, event, actor, {
    approvalId: approval!.id,
    draftId: d.id,
    version: d.version,
    note: input.note ?? null,
  });
  await audit(tx, {
    organizationId: i.organizationId,
    clientId: i.clientId,
    actor,
    action: `response.${dbDecision}`,
    entityType: 'external_interactions',
    entityId: i.id,
    metadata: {
      approvalId: approval!.id,
      draftId: d.id,
      version: d.version,
      contentHash: d.contentHash,
    },
  });

  let jobId: string | null = null;
  if (input.decision === 'approve') {
    if (!i.connectedAccountId) {
      throw new AppError(
        'CONFLICT',
        'La interacción no tiene una fuente conectada desde la que publicar',
      );
    }
    const [job] = await tx<{ id: string }[]>`
      insert into public.publication_jobs
        (organization_id, client_id, interaction_id, draft_id, approval_id, connected_account_id, content, content_hash,
         idempotency_key, requested_by)
      values (${i.organizationId}, ${i.clientId}, ${i.id}, ${d.id}, ${approval!.id}, ${i.connectedAccountId}, ${d.content},
              ${d.contentHash}, ${'pub-' + approval!.id}, ${actor.userId})
      returning id`;
    jobId = job!.id;
    await recordEvent(tx, i, 'publication_queued', actor, { data: { jobId } });
  }
  return { approvalId: approval!.id, jobId };
}

/** Acciones manuales de estado (desde la ficha o por lotes). */
export async function applyAction(
  tx: Tx,
  i: InteractionRow,
  action: 'mark_needs_response' | 'discard' | 'close_without_response' | 'reopen',
  actor: Actor,
  note?: string,
) {
  if (action === 'discard' || action === 'close_without_response') {
    if (i.state === 'publishing') throw new AppError('CONFLICT', 'Hay una publicación en curso');
    await cancelPendingJobs(tx, i.id);
  }
  return transition(tx, i, action, actor, note ? { note } : {});
}

/**
 * Reintento manual de una publicación fallida. El worker consultará el estado
 * remoto ANTES de volver a publicar (attempts > 0).
 */
export async function retryPublish(tx: Tx, i: InteractionRow, actor: Actor) {
  if (i.state !== 'publish_failed')
    throw new AppError('CONFLICT', 'Solo se pueden reintentar publicaciones fallidas');
  const [job] = await tx<{ id: string; status: string }[]>`
    select id, status from public.publication_jobs where interaction_id = ${i.id}
     order by created_at desc limit 1 for update`;
  if (!job) throw new AppError('CONFLICT', 'No hay publicación que reintentar');
  if (job.status === 'queued') return { jobId: job.id, alreadyQueued: true };
  if (job.status !== 'failed')
    throw new AppError('CONFLICT', 'La publicación no se puede reintentar', { status: job.status });
  await tx`update public.publication_jobs set status = 'queued', last_error_kind = null, last_error_message = null where id = ${job.id}`;
  await recordEvent(tx, i, 'publication_retry_requested', actor, { data: { jobId: job.id } });
  await audit(tx, {
    organizationId: i.organizationId,
    clientId: i.clientId,
    actor,
    action: 'publication.retry',
    entityType: 'publication_jobs',
    entityId: job.id,
  });
  return { jobId: job.id, alreadyQueued: false };
}

/** ¿Está bloqueada la publicación por el interruptor global o de la organización? */
export async function publishingBlocked(tx: Tx, organizationId: string): Promise<string | null> {
  const [r] = await tx<{ global: boolean; reason: string | null; paused: boolean }[]>`
    select coalesce((select (value ->> 'enabled')::boolean from public.platform_settings where key = 'publishing_kill_switch'), false) as global,
           (select value ->> 'reason' from public.platform_settings where key = 'publishing_kill_switch') as reason,
           coalesce((select publishing_paused from public.organizations where id = ${organizationId}), true) as paused`;
  if (r?.global) return 'Publicación desactivada globalmente' + (r.reason ? `: ${r.reason}` : '');
  if (r?.paused) return 'Publicación pausada en la organización';
  return null;
}
