import {
  CONNECTION_STATUS_LABELS_ES,
  INTERACTION_STATE_LABELS_ES,
  PRIORITY_LABELS_ES,
  PROVIDER_LABELS_ES,
  type ConnectionStatus,
  type InteractionState,
} from '@rep/shared';
import type { Tone } from '@/components/ui/misc';

export const STATE_TONE: Record<InteractionState, Tone> = {
  new: 'accent',
  analyzed: 'accent',
  pending_response: 'warning',
  draft_generated: 'neutral',
  pending_approval: 'warning',
  approved: 'success',
  publishing: 'accent',
  published: 'success',
  publish_failed: 'danger',
  discarded: 'neutral',
  closed_no_response: 'neutral',
};
export const stateLabel = (s: InteractionState) => INTERACTION_STATE_LABELS_ES[s];

export const PRIORITY_TONE: Record<number, Tone> = {
  1: 'neutral',
  2: 'neutral',
  3: 'warning',
  4: 'danger',
};
export const priorityLabel = (p: number) => PRIORITY_LABELS_ES[p as 1 | 2 | 3 | 4] ?? String(p);
export const providerLabel = (p: string) => PROVIDER_LABELS_ES[p] ?? p;

export const CONNECTION_TONE: Record<ConnectionStatus, Tone> = {
  connected: 'success',
  pending_authorization: 'warning',
  syncing: 'accent',
  insufficient_access: 'danger',
  credentials_expired: 'danger',
  temporary_error: 'warning',
  disconnected: 'neutral',
};
export const connectionLabel = (s: ConnectionStatus) => CONNECTION_STATUS_LABELS_ES[s];

export const RISK_LABELS: Record<string, string> = {
  legal: 'Legal',
  health: 'Salud',
  safety: 'Seguridad',
  discrimination: 'Discriminación',
  prompt_injection: 'Instrucciones sospechosas',
};

export const SYNC_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'En cola', tone: 'neutral' },
  running: { label: 'En curso', tone: 'accent' },
  succeeded: { label: 'Correcta', tone: 'success' },
  partial: { label: 'Parcial', tone: 'warning' },
  failed: { label: 'Fallida', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'En cola', tone: 'neutral' },
  running: { label: 'Publicando', tone: 'accent' },
  published: { label: 'Publicada', tone: 'success' },
  failed: { label: 'Fallida', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};

export const EVENT_LABELS: Record<string, string> = {
  ingested: 'Recibida desde la fuente',
  source_content_changed: 'El autor editó el contenido',
  existing_reply_changed: 'Cambió la respuesta visible en la fuente',
  assigned: 'Asignación cambiada',
  priority_changed: 'Prioridad cambiada',
  specialist_flag_changed: 'Revisión especializada cambiada',
  mark_needs_response: 'Marcada como pendiente de respuesta',
  draft_saved: 'Borrador guardado',
  draft_edited: 'Borrador editado',
  request_approval: 'Enviada a aprobación',
  approve: 'Aprobada',
  reject: 'Rechazada',
  return_to_manager: 'Devuelta al gestor',
  publication_queued: 'Publicación en cola',
  publication_retry_requested: 'Reintento solicitado',
  publication_cancelled: 'Publicación cancelada',
  publish_started: 'Publicación iniciada',
  retry_publish: 'Reintento de publicación',
  publish_confirmed: 'Publicada y verificada',
  publish_failed: 'Error al publicar',
  discard: 'Descartada',
  close_without_response: 'Cerrada sin respuesta',
  reopen: 'Reabierta',
};

export interface InboxItem {
  id: string;
  clientId: string;
  clientName: string;
  provider: string;
  kind: string;
  authorDisplayName: string | null;
  content: string | null;
  rating: string | null;
  ratingScale: number | null;
  state: InteractionState;
  priority: number;
  assigneeId: string | null;
  assigneeName: string | null;
  riskFlags: string[];
  requiresSpecialist: boolean;
  originalCreatedAt: string;
  isSimulated: boolean;
  respondedAt: string | null;
  hasReply: boolean;
}

export interface InboxResponse {
  items: InboxItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: { open: number; pendingApproval: number; publishFailed: number; highPriority: number };
}

export interface Draft {
  id: string;
  version: number;
  content: string;
  contentHash: string;
  source: 'human' | 'ai';
  createdByName: string | null;
  createdAt: string;
}

export interface InteractionDetail {
  interaction: InboxItem & {
    organizationId: string;
    locationName: string | null;
    accountName: string | null;
    accountStatus: ConnectionStatus | null;
    url: string | null;
    language: string | null;
    assigneeEmail: string | null;
    existingReplyContent: string | null;
    existingReplyAt: string | null;
    approvalRequestedAt: string | null;
    firstSeenAt: string;
    updatedAt: string;
  };
  permissions: {
    canUpdate: boolean;
    canDraft: boolean;
    canRequestApproval: boolean;
    canApprove: boolean;
    canRetryPublish: boolean;
  };
  versions: { id: string; content: string | null; rating: string | null; observedAt: string }[];
  drafts: Draft[];
  approvals: {
    id: string;
    draftId: string;
    decision: 'approved' | 'rejected' | 'returned';
    note: string | null;
    specialistReviewed: boolean;
    decidedByName: string | null;
    decidedAt: string;
  }[];
  events: {
    id: string;
    eventType: string;
    fromState: InteractionState | null;
    toState: InteractionState | null;
    actorType: 'user' | 'system';
    actorName: string | null;
    actorEmail: string | null;
    data: Record<string, unknown>;
    createdAt: string;
  }[];
  jobs: {
    id: string;
    status: string;
    attempts: number;
    lastErrorKind: string | null;
    lastErrorMessage: string | null;
    externalReplyId: string | null;
    createdAt: string;
    completedAt: string | null;
  }[];
  attempts: {
    id: string;
    jobId: string;
    attemptNo: number;
    operation: 'publish' | 'status_check';
    outcome: string | null;
    errorMessage: string | null;
    startedAt: string;
  }[];
  receipts: {
    id: string;
    externalReplyId: string | null;
    providerState: string | null;
    verifiedAt: string;
  }[];
}

const dtf = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
export const fmtDateTime = (s: string | null | undefined) => (s ? dtf.format(new Date(s)) : '—');
export const fmtShort = (s: string) => df.format(new Date(s));

export function ratingText(rating: string | null, scale: number | null) {
  if (rating == null) return null;
  return `${Number(rating).toLocaleString('es-ES')}/${scale ?? 5}`;
}
