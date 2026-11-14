/**
 * Sincronización de una cuenta conectada: descarga incremental, deduplicación,
 * detección de ediciones y registro de la ejecución. Cada cuenta se sincroniza
 * en su propio trabajo, de modo que un fallo de un proveedor no afecta al resto.
 */
import { createHmac } from 'node:crypto';
import type { ConnectorError, NormalizedInteraction } from '@rep/connectors';
import { AppError, type InteractionState } from '@rep/shared';
import { withService, type Sql, type Tx } from '../lib/db';
import type { AccountRow, ConnectorRegistry } from './connectors';
import { notify, QUEUES, type JobQueue } from './queue';
import { triage } from './triage';
import { recordEvent, transition, type InteractionRow } from './workflow';

export interface JobDeps {
  sql: Sql;
  registry: ConnectorRegistry;
  queue: JobQueue;
  authorRefPepper: string;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  /** Margen de solape entre ventanas incrementales para no perder elementos en el borde. */
  overlapMinutes?: number;
  maxPages?: number;
  /** Encolar la clasificación por IA de lo nuevo o modificado (si la IA está configurada). */
  aiAutoClassify?: boolean;
}

const DEFAULT_INTERVAL_MIN = 60;

export function authorRef(pepper: string, provider: string, id: string | undefined): string | null {
  return id ? createHmac('sha256', pepper).update(`${provider}:${id}`).digest('hex') : null;
}

async function loadAccount(tx: Tx, id: string) {
  const [a] = await tx<(AccountRow & { isSimulated: boolean })[]>`
    select id, organization_id, client_id, location_id, provider, external_account_id, status, config,
           last_success_sync_at, is_simulated
      from public.connected_accounts where id = ${id}`;
  return a ?? null;
}

/** Crea una ejecución en cola para la cuenta (o devuelve la que ya está en curso). */
export async function enqueueSync(
  tx: Tx,
  accountId: string,
  trigger: 'schedule' | 'manual' | 'webhook' | 'recovery',
  requestedBy: string | null,
): Promise<{ runId: string; created: boolean }> {
  const [existing] = await tx<{ id: string }[]>`
    select id from public.provider_sync_runs where connected_account_id = ${accountId} and status in ('queued', 'running')`;
  if (existing) return { runId: existing.id, created: false };
  const [run] = await tx<{ id: string }[]>`
    insert into public.provider_sync_runs (organization_id, client_id, connected_account_id, trigger, requested_by)
    select organization_id, client_id, id, ${trigger}, ${requestedBy} from public.connected_accounts where id = ${accountId}
    on conflict do nothing
    returning id`;
  if (!run) {
    const [again] = await tx<{ id: string }[]>`
      select id from public.provider_sync_runs where connected_account_id = ${accountId} and status in ('queued', 'running')`;
    if (!again) throw new AppError('CONFLICT', 'No se pudo crear la sincronización');
    return { runId: again.id, created: false };
  }
  return { runId: run.id, created: true };
}

interface Counters {
  found: number;
  created: number;
  updated: number;
  errors: number;
  toClassify: string[];
}

async function ingest(
  tx: Tx,
  account: AccountRow & { isSimulated: boolean },
  item: NormalizedInteraction,
  pepper: string,
  c: Counters,
  autoClassify: boolean,
) {
  // La IA solo se pide si está activa para el cliente; el worker vuelve a comprobarlo.
  const aiStatus = autoClassify
    ? tx`(case when (select ai_enabled from public.clients where id = ${account.clientId})
               then 'pending' else 'not_requested' end)::public.ai_analysis_status`
    : tx`'not_requested'::public.ai_analysis_status`;
  const [cur] = await tx<
    (InteractionRow & {
      contentHash: string;
      existingReplyContent: string | null;
      riskFlags: string[];
    })[]
  >`
    select id, organization_id, client_id, connected_account_id, provider, state, requires_specialist, assignee_id, priority,
           content_hash, existing_reply_content, risk_flags
      from public.external_interactions
     where provider = ${account.provider} and connected_account_id = ${account.id} and external_id = ${item.externalId}
     for update`;
  const t = triage(item.content, item.rating, item.ratingScale);
  const reply = item.existingReply;
  if (!cur) {
    const [row] = await tx<{ id: string }[]>`
      insert into public.external_interactions
        (organization_id, client_id, location_id, connected_account_id, provider, kind, external_id, external_parent_id, url,
         author_display_name, author_ref_hash, content, language, rating, rating_scale, content_hash, original_created_at,
         priority, risk_flags, requires_specialist, existing_reply_content, existing_reply_at, is_simulated, ai_status)
      values (${account.organizationId}, ${account.clientId}, ${account.locationId}, ${account.id}, ${account.provider},
              ${item.kind}, ${item.externalId}, ${item.externalParentId ?? null}, ${item.url ?? null},
              ${item.authorName ?? null}, ${authorRef(pepper, account.provider, item.authorExternalId)},
              ${item.content}, ${item.language ?? null}, ${item.rating ?? null}, ${item.ratingScale ?? null},
              ${item.contentHash}, ${item.createdAt}, ${t.priority}, ${t.riskFlags}, ${t.requiresSpecialist},
              ${reply?.content ?? null}, ${reply?.updatedAt ?? null}, ${account.isSimulated}, ${aiStatus})
      on conflict on constraint external_interactions_dedupe do nothing
      returning id`;
    if (!row) return; // otra ejecución la insertó a la vez: se tratará en la siguiente pasada
    const base = { id: row.id, organizationId: account.organizationId, clientId: account.clientId };
    await tx`
      insert into public.interaction_versions (organization_id, client_id, interaction_id, content, rating, content_hash)
      values (${account.organizationId}, ${account.clientId}, ${row.id}, ${item.content}, ${item.rating ?? null}, ${item.contentHash})`;
    await recordEvent(
      tx,
      base,
      'ingested',
      { userId: null },
      {
        data: { provider: account.provider, triage: t, existingReply: Boolean(reply) },
      },
    );
    c.created++;
    if (autoClassify) c.toClassify.push(row.id);
    return;
  }

  const contentChanged = cur.contentHash !== item.contentHash;
  const replyChanged = (reply?.content ?? null) !== cur.existingReplyContent;
  if (!contentChanged && !replyChanged) {
    await tx`update public.external_interactions set last_seen_at = now() where id = ${cur.id}`;
    return;
  }
  const flags = [...new Set([...cur.riskFlags, ...t.riskFlags])];
  await tx`
    update public.external_interactions set
      content = ${item.content}, rating = ${item.rating ?? null}, content_hash = ${item.contentHash},
      existing_reply_content = ${reply?.content ?? null}, existing_reply_at = ${reply?.updatedAt ?? null},
      priority = greatest(priority, ${t.priority}), risk_flags = ${flags},
      requires_specialist = requires_specialist or ${t.requiresSpecialist}, last_seen_at = now(),
      ai_status = case when ${contentChanged && autoClassify} then ${aiStatus} else ai_status end,
      ai_attempts = case when ${contentChanged && autoClassify} then 0 else ai_attempts end
     where id = ${cur.id}`;
  if (contentChanged && autoClassify) c.toClassify.push(cur.id);
  if (contentChanged) {
    await tx`
      insert into public.interaction_versions (organization_id, client_id, interaction_id, content, rating, content_hash)
      values (${cur.organizationId}, ${cur.clientId}, ${cur.id}, ${item.content}, ${item.rating ?? null}, ${item.contentHash})`;
    await recordEvent(tx, cur, 'source_content_changed', { userId: null }, { data: { triage: t } });
    // Si el autor cambió su reseña mientras había una respuesta aprobada o en revisión,
    // la aprobación deja de ser válida: se vuelve a borrador.
    const reopen: InteractionState[] = ['pending_approval', 'approved'];
    if (reopen.includes(cur.state)) {
      await tx`
        update public.publication_jobs set status = 'cancelled', completed_at = now()
         where interaction_id = ${cur.id} and status in ('queued', 'failed')`;
      await transition(
        tx,
        cur,
        'draft_edited',
        { userId: null },
        { reason: 'source_changed' },
        {
          requiresSpecialist: cur.requiresSpecialist || t.requiresSpecialist,
        },
      );
    }
  }
  if (replyChanged) await recordEvent(tx, cur, 'existing_reply_changed', { userId: null });
  c.updated++;
}

function accountStatusFor(e: ConnectorError): string {
  switch (e.kind) {
    case 'credentials_expired':
      return 'credentials_expired';
    case 'not_authorized':
    case 'insufficient_permissions':
      return 'insufficient_access';
    default:
      return 'temporary_error';
  }
}

export async function runSync(deps: JobDeps, runId: string) {
  const { sql } = deps;
  const claimed = await withService(sql, null, async (tx) => {
    const [r] = await tx<{ id: string; connectedAccountId: string; startedAt: Date }[]>`
      update public.provider_sync_runs set status = 'running', started_at = now()
       where id = ${runId} and status = 'queued' returning id, connected_account_id, started_at`;
    if (!r) return null;
    const account = await loadAccount(tx, r.connectedAccountId);
    if (account && account.status !== 'disconnected') {
      await tx`update public.connected_accounts set status = 'syncing', last_attempt_at = now() where id = ${account.id}`;
    }
    return r && account ? { run: r, account } : null;
  });
  if (!claimed) return { status: 'skipped' as const };
  const { run, account } = claimed;
  const c: Counters = { found: 0, created: 0, updated: 0, errors: 0, toClassify: [] };

  const finish = async (
    status: 'succeeded' | 'partial' | 'failed' | 'cancelled',
    err?: ConnectorError,
  ) =>
    withService(sql, null, async (tx) => {
      await tx`
        update public.provider_sync_runs set status = ${status}, finished_at = now(), items_found = ${c.found},
               items_created = ${c.created}, items_updated = ${c.updated}, error_count = ${c.errors},
               failure_kind = ${err?.kind ?? null}, failure_reason = ${err?.message.slice(0, 1000) ?? null}
         where id = ${run.id} and status = 'running'`;
      if (status === 'cancelled') return;
      const interval =
        Number((account.config as { syncIntervalMinutes?: number }).syncIntervalMinutes) ||
        DEFAULT_INTERVAL_MIN;
      if (status === 'failed') {
        await tx`
          update public.connected_accounts set status = ${accountStatusFor(err!)}::public.connection_status,
                 last_error_kind = ${err!.kind}, last_error_message = ${err!.message.slice(0, 1000)},
                 next_run_at = now() + make_interval(mins => ${err!.retryable ? Math.min(interval, 15) : interval})
           where id = ${account.id} and status <> 'disconnected'`;
      } else {
        await tx`
          update public.connected_accounts set status = 'connected', last_success_sync_at = ${run.startedAt},
                 last_error_kind = null, last_error_message = null, next_run_at = now() + make_interval(mins => ${interval})
           where id = ${account.id} and status <> 'disconnected'`;
      }
    });

  if (account.status === 'disconnected') {
    await finish('cancelled');
    return { status: 'cancelled' as const };
  }
  const resolved = await deps.registry.resolve(account);
  if (!resolved) {
    const err: ConnectorError = {
      kind: 'not_supported',
      message: 'Integración no disponible todavía para este proveedor',
      retryable: false,
    };
    await finish('failed', err);
    return { status: 'failed' as const, error: err };
  }
  const { connector, credentials } = resolved;
  const overlap = (deps.overlapMinutes ?? 15) * 60_000;
  const since = account.lastSuccessSyncAt
    ? new Date(account.lastSuccessSyncAt.getTime() - overlap)
    : undefined;
  let cursor: string | undefined;
  for (let page = 0; page < (deps.maxPages ?? 50); page++) {
    // Permite cancelar entre páginas.
    const [state] = await withService(
      sql,
      null,
      (tx) =>
        tx<{ status: string }[]>`select status from public.provider_sync_runs where id = ${run.id}`,
    );
    if (state?.status !== 'running') return { status: 'cancelled' as const };
    const res = await connector.fetchInteractions({
      credentials,
      accountExternalId: account.externalAccountId,
      since,
      cursor,
      pageSize: 50,
    });
    if (!res.ok) {
      await finish(c.created + c.updated > 0 ? 'partial' : 'failed', res.error);
      return { status: 'failed' as const, error: res.error };
    }
    c.found += res.value.items.length;
    for (const item of res.value.items) {
      try {
        c.toClassify = [];
        await withService(sql, null, (tx) =>
          ingest(tx, account, item, deps.authorRefPepper, c, deps.aiAutoClassify ?? false),
        );
        // Aviso tras el commit (outbox): si se pierde, el barrido lo recupera.
        for (const id of c.toClassify) await notify(deps.queue, QUEUES.classify, id, deps.log);
      } catch (err) {
        c.errors++;
        deps.log?.warn({ err, runId: run.id, externalId: item.externalId }, 'ingest failed');
      }
    }
    cursor = res.value.nextCursor;
    if (!cursor) break;
  }
  await finish(c.errors > 0 ? 'partial' : 'succeeded');
  const { toClassify: _ignored, ...counters } = c;
  deps.log?.info({ runId: run.id, ...counters }, 'sync finished');
  return {
    status: c.errors > 0 ? ('partial' as const) : ('succeeded' as const),
    counters,
  };
}

/** Programa sincronizaciones vencidas (llamado por el barrido periódico). */
export async function scheduleDueSyncs(deps: JobDeps, limit = 50) {
  const runIds = await withService(deps.sql, null, async (tx) => {
    const due = await tx<{ id: string }[]>`
      select id from public.connected_accounts
       where status in ('connected', 'temporary_error') and next_run_at is not null and next_run_at <= now()
       order by next_run_at limit ${limit} for update skip locked`;
    const ids: string[] = [];
    for (const a of due) {
      const r = await enqueueSync(tx, a.id, 'schedule', null);
      if (r.created) ids.push(r.runId);
    }
    return ids;
  });
  for (const id of runIds) await notify(deps.queue, QUEUES.sync, id, deps.log);
  return runIds.length;
}
