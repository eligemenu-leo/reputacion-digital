/**
 * Máquina de estados de una interacción (reseña, comentario o mención).
 * Se define en Fase 0 como contrato; el backend la aplicará en Fase 2 y
 * la base de datos la reforzará con un trigger equivalente.
 */
export const INTERACTION_STATES = [
  'new',
  'analyzed',
  'pending_response',
  'draft_generated',
  'pending_approval',
  'approved',
  'publishing',
  'published',
  'publish_failed',
  'discarded',
  'closed_no_response',
] as const;
export type InteractionState = (typeof INTERACTION_STATES)[number];

export const INTERACTION_STATE_LABELS_ES: Record<InteractionState, string> = {
  new: 'Nueva',
  analyzed: 'Analizada',
  pending_response: 'Pendiente de respuesta',
  draft_generated: 'Borrador generado',
  pending_approval: 'Pendiente de aprobación',
  approved: 'Aprobada',
  publishing: 'Publicación en curso',
  published: 'Publicada',
  publish_failed: 'Error de publicación',
  discarded: 'Descartada',
  closed_no_response: 'Cerrada sin respuesta',
};

export type InteractionEvent =
  | 'analysis_completed'
  | 'mark_needs_response'
  | 'draft_saved'
  | 'request_approval'
  | 'approve'
  | 'reject'
  | 'return_to_manager'
  | 'draft_edited'
  | 'publish_started'
  | 'publish_confirmed'
  | 'publish_failed'
  | 'retry_publish'
  | 'discard'
  | 'close_without_response'
  | 'reopen';

const T: Record<InteractionState, Partial<Record<InteractionEvent, InteractionState>>> = {
  new: {
    analysis_completed: 'analyzed',
    mark_needs_response: 'pending_response',
    draft_saved: 'draft_generated',
    discard: 'discarded',
    close_without_response: 'closed_no_response',
  },
  analyzed: {
    mark_needs_response: 'pending_response',
    draft_saved: 'draft_generated',
    discard: 'discarded',
    close_without_response: 'closed_no_response',
  },
  pending_response: {
    draft_saved: 'draft_generated',
    discard: 'discarded',
    close_without_response: 'closed_no_response',
  },
  draft_generated: {
    draft_saved: 'draft_generated',
    draft_edited: 'draft_generated',
    request_approval: 'pending_approval',
    discard: 'discarded',
    close_without_response: 'closed_no_response',
  },
  pending_approval: {
    approve: 'approved',
    reject: 'draft_generated',
    return_to_manager: 'draft_generated',
    // Editar durante la revisión devuelve a borrador: hay que volver a solicitar aprobación.
    draft_edited: 'draft_generated',
    discard: 'discarded',
  },
  approved: {
    publish_started: 'publishing',
    // Modificar el texto aprobado invalida la aprobación.
    draft_edited: 'draft_generated',
    return_to_manager: 'draft_generated',
    discard: 'discarded',
  },
  publishing: {
    publish_confirmed: 'published',
    publish_failed: 'publish_failed',
  },
  publish_failed: {
    // El reintento exige consultar antes el estado remoto (lo hace el worker).
    retry_publish: 'publishing',
    draft_edited: 'draft_generated',
    discard: 'discarded',
  },
  published: {},
  discarded: { reopen: 'pending_response' },
  closed_no_response: { reopen: 'pending_response' },
};

export function nextInteractionState(
  from: InteractionState,
  event: InteractionEvent,
): InteractionState | null {
  return T[from][event] ?? null;
}

export function allowedEvents(from: InteractionState): InteractionEvent[] {
  return Object.keys(T[from]) as InteractionEvent[];
}

export const TERMINAL_STATES: readonly InteractionState[] = ['published'];

/** Solo se puede publicar desde 'approved' (o reintentar desde 'publish_failed'). */
export function canPublish(state: InteractionState): boolean {
  return state === 'approved' || state === 'publish_failed';
}
