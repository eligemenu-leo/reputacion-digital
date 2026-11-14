/**
 * Motor de publicación. Garantías:
 *  1. Solo publica trabajos cuya aprobación sigue vigente (lo comprueba aquí y
 *     lo impone la BD al crear el trabajo).
 *  2. Reclama el trabajo de forma atómica (queued → running): dos workers no
 *     pueden publicar el mismo trabajo.
 *  3. Antes de cualquier reintento, o tras una respuesta ambigua, CONSULTA el
 *     estado remoto; si la respuesta ya está publicada, la confirma sin volver
 *     a enviarla.
 *  4. Consulta los interruptores (global y de organización) justo antes de publicar.
 *  5. Cada intento queda registrado (publication_attempts) y el resultado final
 *     verificado en publication_receipts.
 */
import type {
  ConnectorError,
  PublicationReceipt,
  ProviderConnector,
  ProviderCredentials,
} from '@rep/connectors';
import { responseHash } from '@rep/shared';
import { withService, type Tx } from '../lib/db';
import { notify, QUEUES } from './queue';
import type { JobDeps } from './sync';
import { audit, lockInteraction, publishingBlocked, recordEvent, transition } from './workflow';

export const MAX_PUBLISH_ATTEMPTS = 4;
const SYSTEM = { userId: null };

interface JobRow {
  id: string;
  organizationId: string;
  clientId: string;
  interactionId: string;
  approvalId: string;
  connectedAccountId: string;
  content: string;
  contentHash: string;
  idempotencyKey: string;
  attempts: number;
}

async function startAttempt(tx: Tx, job: JobRow, op: 'publish' | 'status_check') {
  const [a] = await tx<{ id: string }[]>`
    insert into public.publication_attempts (organization_id, client_id, job_id, attempt_no, operation)
    values (${job.organizationId}, ${job.clientId}, ${job.id}, ${job.attempts}, ${op}) returning id`;
  return a!.id;
}

async function endAttempt(
  tx: Tx,
  attemptId: string,
  outcome: 'published' | 'not_found' | 'failed' | 'ambiguous' | 'blocked',
  err?: ConnectorError | { kind: string; message: string },
) {
  await tx`
    update public.publication_attempts set finished_at = now(), outcome = ${outcome},
           error_kind = ${err?.kind ?? null}, error_message = ${err?.message.slice(0, 1000) ?? null}
     where id = ${attemptId}`;
}

export async function runPublish(deps: JobDeps, jobId: string) {
  const { sql } = deps;

  // 1) Reclamar el trabajo y comprobar que sigue siendo legítimo.
  const claim = await withService(sql, null, async (tx) => {
    const [job] = await tx<JobRow[]>`
      update public.publication_jobs set status = 'running', attempts = attempts + 1
       where id = ${jobId} and status = 'queued'
      returning id, organization_id, client_id, interaction_id, approval_id, connected_account_id, content, content_hash,
                idempotency_key, attempts`;
    if (!job) return { kind: 'skip' as const };
    const i = await lockInteraction(tx, job.interactionId);

    const [latest] = await tx<{ id: string; decision: string }[]>`
      select id, decision from public.response_approvals where interaction_id = ${i.id}
       order by decided_at desc, id desc limit 1`;
    const hashOk = (await responseHash(job.content)) === job.contentHash;
    if (
      latest?.id !== job.approvalId ||
      latest.decision !== 'approved' ||
      !hashOk ||
      (i.state !== 'approved' && i.state !== 'publish_failed')
    ) {
      await tx`update public.publication_jobs set status = 'cancelled', completed_at = now(),
                 last_error_kind = 'approval_invalidated', last_error_message = 'La aprobación ya no es válida'
               where id = ${job.id}`;
      await recordEvent(tx, i, 'publication_cancelled', SYSTEM, {
        data: { jobId: job.id, reason: 'approval_invalidated' },
      });
      return { kind: 'cancelled' as const };
    }

    const blocked = await publishingBlocked(tx, job.organizationId);
    if (blocked) {
      // No es un fallo: el trabajo vuelve a la cola y se reintentará cuando se reactive.
      const att = await startAttempt(tx, job, 'publish');
      await endAttempt(tx, att, 'blocked', { kind: 'paused', message: blocked });
      await tx`update public.publication_jobs set status = 'queued', attempts = attempts - 1,
                 last_error_kind = 'paused', last_error_message = ${blocked} where id = ${job.id}`;
      return { kind: 'blocked' as const, reason: blocked };
    }

    const [account] = await tx<
      {
        id: string;
        provider: string;
        status: string;
        externalAccountId: string;
        config: Record<string, unknown>;
        organizationId: string;
        clientId: string;
        locationId: string | null;
        lastSuccessSyncAt: Date | null;
      }[]
    >`
      select id, provider, status, external_account_id, config, organization_id, client_id, location_id, last_success_sync_at
        from public.connected_accounts where id = ${job.connectedAccountId}`;
    const [ext] = await tx<{ externalId: string }[]>`
      select external_id from public.external_interactions where id = ${i.id}`;
    await transition(tx, i, i.state === 'approved' ? 'publish_started' : 'retry_publish', SYSTEM, {
      jobId: job.id,
      attempt: job.attempts,
    });
    return { kind: 'go' as const, job, account: account!, externalId: ext!.externalId };
  });
  if (claim.kind !== 'go') return { status: claim.kind };
  const { job, account, externalId } = claim;

  const resolved = account.status === 'disconnected' ? null : await deps.registry.resolve(account);
  if (!resolved) {
    return fail(deps, job, {
      kind: 'not_supported',
      message: 'La fuente no está disponible para publicar',
      retryable: false,
    });
  }
  const { connector, credentials } = resolved;
  const base = {
    credentials,
    accountExternalId: account.externalAccountId,
    interactionExternalId: externalId,
    idempotencyKey: job.idempotencyKey,
  };

  // 2) Reintento: consultar primero si ya está publicada (evita duplicados).
  if (job.attempts > 1) {
    const check = await statusCheck(deps, job, connector, base);
    if (check === 'published') return { status: 'published' as const, viaStatusCheck: true };
    if (check === 'error') return { status: 'failed' as const };
  }

  // 3) Publicar.
  const attemptId = await withService(sql, null, (tx) => startAttempt(tx, job, 'publish'));
  const res = await connector.publishReply({ ...base, content: job.content });
  if (res.ok && res.value.status === 'published') {
    await withService(sql, null, (tx) => endAttempt(tx, attemptId, 'published'));
    // Verificación posterior: confirmamos que el texto visible es el aprobado.
    const verify = await connector.getPublicationStatus({ ...base, expectedContent: job.content });
    const receipt = verify.ok && verify.value.status === 'published' ? verify.value : res.value;
    await confirm(deps, job, receipt);
    return { status: 'published' as const };
  }
  const err: ConnectorError = res.ok
    ? {
        kind: 'ambiguous',
        message: `Estado de publicación no confirmado (${res.value.status})`,
        retryable: true,
      }
    : res.error;
  await withService(sql, null, (tx) =>
    endAttempt(tx, attemptId, err.kind === 'ambiguous' ? 'ambiguous' : 'failed', err),
  );

  // 4) Respuesta ambigua: consultar el estado remoto antes de decidir.
  if (err.kind === 'ambiguous') {
    const check = await statusCheck(deps, job, connector, base);
    if (check === 'published') return { status: 'published' as const, viaStatusCheck: true };
    if (check === 'error') return { status: 'failed' as const };
  }
  return fail(deps, job, err);
}

async function statusCheck(
  deps: JobDeps,
  job: JobRow,
  connector: ProviderConnector,
  base: {
    credentials: ProviderCredentials;
    accountExternalId: string;
    interactionExternalId: string;
    idempotencyKey: string;
  },
): Promise<'published' | 'not_found' | 'error'> {
  const attemptId = await withService(deps.sql, null, (tx) =>
    startAttempt(tx, job, 'status_check'),
  );
  const st = await connector.getPublicationStatus({ ...base, expectedContent: job.content });
  if (st.ok && st.value.status === 'published') {
    await withService(deps.sql, null, (tx) => endAttempt(tx, attemptId, 'published'));
    await confirm(deps, job, st.value);
    return 'published';
  }
  if (st.ok && st.value.status === 'not_found') {
    await withService(deps.sql, null, (tx) => endAttempt(tx, attemptId, 'not_found'));
    return 'not_found';
  }
  // Hay otra respuesta distinta publicada, o no se puede consultar: no se reintenta a ciegas.
  const err: ConnectorError = st.ok
    ? {
        kind: 'provider_error',
        message: 'El proveedor muestra una respuesta distinta a la aprobada',
        retryable: false,
      }
    : {
        ...st.error,
        retryable: false,
        message: `No se pudo consultar el estado remoto: ${st.error.message}`,
      };
  await withService(deps.sql, null, (tx) => endAttempt(tx, attemptId, 'failed', err));
  await fail(deps, job, err);
  return 'error';
}

async function confirm(deps: JobDeps, job: JobRow, receipt: PublicationReceipt) {
  await withService(deps.sql, null, async (tx) => {
    const publishedHash = receipt.publishedContent
      ? await responseHash(receipt.publishedContent)
      : job.contentHash;
    await tx`
      insert into public.publication_receipts (organization_id, client_id, job_id, external_reply_id, published_content_hash, provider_state)
      values (${job.organizationId}, ${job.clientId}, ${job.id}, ${receipt.externalReplyId ?? null}, ${publishedHash},
              ${receipt.providerState ?? receipt.status})
      on conflict (job_id) do nothing`;
    await tx`
      update public.publication_jobs set status = 'published', completed_at = now(), external_reply_id = ${receipt.externalReplyId ?? null},
             last_error_kind = null, last_error_message = null
       where id = ${job.id}`;
    const i = await lockInteraction(tx, job.interactionId);
    if (i.state === 'publishing') {
      await transition(
        tx,
        i,
        'publish_confirmed',
        SYSTEM,
        { jobId: job.id, externalReplyId: receipt.externalReplyId ?? null },
        {
          respondedAt: new Date(),
          existingReplyContent: job.content,
          existingReplyAt: new Date(),
        },
      );
    }
    await audit(tx, {
      organizationId: job.organizationId,
      clientId: job.clientId,
      actor: SYSTEM,
      action: 'publication.published',
      entityType: 'publication_jobs',
      entityId: job.id,
      metadata: { interactionId: job.interactionId, attempts: job.attempts },
    });
  });
}

async function fail(deps: JobDeps, job: JobRow, err: ConnectorError) {
  const retry = err.retryable && job.attempts < MAX_PUBLISH_ATTEMPTS;
  await withService(deps.sql, null, async (tx) => {
    await tx`
      update public.publication_jobs set status = ${retry ? 'queued' : 'failed'}, last_error_kind = ${err.kind},
             last_error_message = ${err.message.slice(0, 1000)}
       where id = ${job.id} and status = 'running'`;
    const i = await lockInteraction(tx, job.interactionId);
    if (i.state === 'publishing') {
      await transition(tx, i, 'publish_failed', SYSTEM, {
        jobId: job.id,
        error: err.kind,
        willRetry: retry,
      });
    }
    if (err.kind === 'credentials_expired') {
      await tx`update public.connected_accounts set status = 'credentials_expired', last_error_kind = ${err.kind},
                 last_error_message = ${err.message} where id = ${job.connectedAccountId}`;
    }
    if (!retry) {
      await audit(tx, {
        organizationId: job.organizationId,
        clientId: job.clientId,
        actor: SYSTEM,
        action: 'publication.failed',
        entityType: 'publication_jobs',
        entityId: job.id,
        metadata: { error: err.kind, attempts: job.attempts },
      });
    }
  });
  if (retry) {
    const delay = err.retryAfterSec ?? Math.min(30 * 2 ** (job.attempts - 1), 600);
    await notify(deps.queue, QUEUES.publish, job.id, deps.log, { startAfterSeconds: delay });
  }
  return { status: 'failed' as const, willRetry: retry, error: err };
}

/**
 * Barrido de recuperación: vuelve a encolar trabajos cuyo aviso se perdió y
 * libera los que quedaron «running» por una caída (el siguiente intento
 * consultará el estado remoto antes de publicar).
 */
export async function sweepPublications(deps: JobDeps, opts: { staleQueuedSeconds?: number } = {}) {
  const stale = opts.staleQueuedSeconds ?? 120;
  const ids = await withService(deps.sql, null, async (tx) => {
    await tx`
      update public.publication_jobs set status = 'queued', last_error_kind = 'worker_lost',
             last_error_message = 'El trabajo se interrumpió; se comprobará el estado remoto antes de reintentar'
       where status = 'running' and updated_at < now() - interval '10 minutes'`;
    const rows = await tx<{ id: string }[]>`
      select id from public.publication_jobs where status = 'queued' and updated_at < now() - make_interval(secs => ${stale})
       order by updated_at limit 100`;
    return rows.map((r) => r.id);
  });
  for (const id of ids) await notify(deps.queue, QUEUES.publish, id, deps.log);
  return ids.length;
}

export async function sweepSyncRuns(deps: JobDeps) {
  const ids = await withService(deps.sql, null, async (tx) => {
    const stale = await tx<{ connectedAccountId: string }[]>`
      update public.provider_sync_runs set status = 'failed', finished_at = now(), failure_kind = 'worker_lost',
             failure_reason = 'La sincronización se interrumpió'
       where status = 'running' and started_at < now() - interval '30 minutes' returning connected_account_id`;
    for (const s of stale) {
      await tx`update public.connected_accounts set status = 'temporary_error', next_run_at = now()
                where id = ${s.connectedAccountId} and status = 'syncing'`;
    }
    const rows = await tx<{ id: string }[]>`
      select id from public.provider_sync_runs where status = 'queued' and created_at < now() - interval '2 minutes' limit 100`;
    return rows.map((r) => r.id);
  });
  for (const id of ids) await notify(deps.queue, QUEUES.sync, id, deps.log);
  return ids.length;
}
