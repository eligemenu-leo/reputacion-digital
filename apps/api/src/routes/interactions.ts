import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  batchSchema,
  decisionSchema,
  draftInputSchema,
  inboxQuerySchema,
  interactionActionSchema,
  interactionPatchSchema,
  OPEN_STATES,
  uuidSchema,
  type Permission,
} from '@rep/shared';
import { z } from 'zod';
import { requireAuth } from '../app';
import { elevate, withUser, type Sql, type Tx } from '../lib/db';
import { requireClientAction, requireOrgPermission } from '../lib/authz';
import { parse } from '../lib/http';
import type { AuthContext } from '../lib/auth';
import { notify, QUEUES } from '../domain/queue';
import {
  applyAction,
  decide,
  lockInteraction,
  recordEvent,
  requestApproval,
  retryPublish,
  saveDraft,
  type Actor,
  type InteractionRow,
} from '../domain/workflow';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/**
 * Carga la interacción como el usuario (RLS → 404 si no la ve), comprueba el
 * permiso sobre su cliente (403), eleva a service_role y la bloquea.
 */
export async function withInteraction<T>(
  sql: Sql,
  auth: AuthContext,
  id: string,
  perms: Permission | Permission[],
  fn: (tx: Tx, row: InteractionRow) => Promise<T>,
): Promise<T> {
  return withUser(sql, auth, async (tx) => {
    const [vis] = await tx<
      { clientId: string }[]
    >`select client_id from public.external_interactions where id = ${id}`;
    if (!vis) throw new AppError('NOT_FOUND', 'Interacción no encontrada');
    const list = Array.isArray(perms) ? perms : [perms];
    let lastErr: unknown;
    let allowed = false;
    for (const p of list) {
      try {
        await requireClientAction(tx, vis.clientId, p);
        allowed = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!allowed) throw lastErr;
    await elevate(tx);
    const row = await lockInteraction(tx, id);
    return fn(tx, row);
  });
}

const actorOf = (req: FastifyRequest, auth: AuthContext): Actor => ({
  userId: auth.userId,
  requestId: req.id,
});

export async function interactionRoutes(app: FastifyInstance) {
  const { sql, queue } = app.deps;
  const idOf = (p: unknown, k: string) => parse(uuidSchema, (p as Record<string, string>)[k]);

  // ---------------------------------------------------------------------------
  // Bandeja
  // ---------------------------------------------------------------------------
  app.get('/organizations/:orgId/interactions', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const q = parse(inboxQuerySchema, req.query);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      const states = q.state?.length ? q.state : null;
      const prios = q.priority?.length ? q.priority : null;
      const assignee =
        q.assignee === 'me' ? auth.userId : q.assignee === 'none' ? null : (q.assignee ?? null);
      const text = q.q ? q.q : null;
      const like = q.q ? `%${escapeLike(q.q)}%` : null;
      const order = {
        date: 'i.original_created_at',
        priority: 'i.priority',
        rating: 'i.rating',
      }[q.sort];
      const dir = q.dir === 'asc' ? 'asc nulls first' : 'desc nulls last';
      const rows = await tx`
        select i.id, i.client_id, c.name as client_name, i.provider, i.kind, i.author_display_name, i.content, i.rating,
               i.rating_scale, i.state, i.priority, i.assignee_id, p.full_name as assignee_name, i.risk_flags,
               i.requires_specialist, i.original_created_at, i.is_simulated, i.responded_at,
               (i.existing_reply_content is not null) as has_reply,
               count(*) over()::int as total_count
          from public.external_interactions i
          join public.clients c on c.id = i.client_id
          left join public.profiles p on p.id = i.assignee_id
         where i.organization_id = ${orgId}
           and (${q.clientId ?? null}::uuid is null or i.client_id = ${q.clientId ?? null}::uuid)
           and (${q.provider ?? null}::text is null or i.provider = ${q.provider ?? null}::text)
           and (${states}::public.interaction_state[] is null or i.state = any(${states}::public.interaction_state[]))
           and (${prios}::int[] is null or i.priority = any(${prios}::int[]))
           and (${q.ratingMin ?? null}::numeric is null or i.rating >= ${q.ratingMin ?? null}::numeric)
           and (${q.ratingMax ?? null}::numeric is null or i.rating <= ${q.ratingMax ?? null}::numeric)
           and (${q.assignee ?? null}::text is null
                or (${q.assignee ?? null}::text = 'none' and i.assignee_id is null)
                or (${q.assignee ?? null}::text <> 'none' and i.assignee_id = ${assignee}::uuid))
           and (${q.unanswered ?? false} = false or (i.existing_reply_content is null and i.responded_at is null))
           and (${q.from ?? null}::date is null or i.original_created_at >= ${q.from ?? null}::date)
           and (${q.to ?? null}::date is null or i.original_created_at < ${q.to ?? null}::date + 1)
           and (${text}::text is null
                or i.search @@ plainto_tsquery('simple', ${text}::text)
                or i.author_display_name ilike ${like})
         order by ${tx.unsafe(order)} ${tx.unsafe(dir)}, i.original_created_at desc, i.id
         limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`;
      const [counts] = await tx`
        select count(*) filter (where state = any(${OPEN_STATES as string[]}::public.interaction_state[]))::int as open,
               count(*) filter (where state = 'pending_approval')::int as pending_approval,
               count(*) filter (where state = 'publish_failed')::int as publish_failed,
               count(*) filter (where state = any(${OPEN_STATES as string[]}::public.interaction_state[]) and priority >= 3)::int as high_priority
          from public.external_interactions where organization_id = ${orgId}`;
      const total = (rows[0] as { totalCount?: number } | undefined)?.totalCount ?? 0;
      return {
        items: rows.map(({ totalCount: _t, ...r }) => r),
        page: q.page,
        pageSize: q.pageSize,
        total,
        counts,
      };
    });
  });

  // ---------------------------------------------------------------------------
  // Detalle
  // ---------------------------------------------------------------------------
  app.get('/interactions/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    return withUser(sql, auth, async (tx) => {
      const [interaction] = await tx`
        select i.id, i.organization_id, i.client_id, c.name as client_name, i.location_id, l.name as location_name,
               i.connected_account_id, a.display_name as account_name, a.status as account_status, i.provider, i.kind,
               i.external_id, i.url, i.author_display_name, i.content, i.language, i.rating, i.rating_scale,
               i.original_created_at, i.first_seen_at, i.last_seen_at, i.state, i.priority, i.assignee_id,
               p.full_name as assignee_name, p.email as assignee_email, i.sentiment, i.category, i.risk_flags,
               i.requires_specialist, i.existing_reply_content, i.existing_reply_at, i.approval_requested_by,
               i.approval_requested_at, i.responded_at, i.is_simulated, i.updated_at
          from public.external_interactions i
          join public.clients c on c.id = i.client_id
          left join public.client_locations l on l.id = i.location_id
          left join public.connected_accounts a on a.id = i.connected_account_id
          left join public.profiles p on p.id = i.assignee_id
         where i.id = ${id}`;
      if (!interaction) throw new AppError('NOT_FOUND', 'Interacción no encontrada');
      const clientId = (interaction as { clientId: string }).clientId;
      const [perm] = await tx`
        select private.has_client_permission(${clientId}::uuid, 'interactions.update') as can_update,
               private.has_client_permission(${clientId}::uuid, 'drafts.write') as can_draft,
               private.has_client_permission(${clientId}::uuid, 'approvals.request') as can_request_approval,
               private.has_client_permission(${clientId}::uuid, 'responses.approve') as can_approve,
               (private.has_client_permission(${clientId}::uuid, 'responses.publish')
                 or private.has_client_permission(${clientId}::uuid, 'responses.approve')) as can_retry_publish`;
      const [versions, drafts, approvals, events, jobs, attempts, receipts] = await Promise.all([
        tx`select id, content, rating, content_hash, observed_at from public.interaction_versions
            where interaction_id = ${id} order by observed_at desc limit 20`,
        tx`select d.id, d.version, d.content, d.content_hash, d.source, d.created_by, p.full_name as created_by_name, d.created_at
             from public.response_drafts d left join public.profiles p on p.id = d.created_by
            where d.interaction_id = ${id} order by d.version desc limit 50`,
        tx`select a.id, a.draft_id, a.content_hash, a.decision, a.note, a.specialist_reviewed, a.decided_by,
                  p.full_name as decided_by_name, a.decided_at
             from public.response_approvals a left join public.profiles p on p.id = a.decided_by
            where a.interaction_id = ${id} order by a.decided_at desc, a.id desc`,
        tx`select e.id::text, e.event_type, e.from_state, e.to_state, e.actor_user_id, e.actor_type,
                  p.full_name as actor_name, p.email as actor_email, e.data, e.created_at
             from public.interaction_events e left join public.profiles p on p.id = e.actor_user_id
            where e.interaction_id = ${id} order by e.id desc limit 200`,
        tx`select id, draft_id, approval_id, status, attempts, last_error_kind, last_error_message, external_reply_id,
                  created_at, updated_at, completed_at
             from public.publication_jobs where interaction_id = ${id} order by created_at desc`,
        tx`select t.id, t.job_id, t.attempt_no, t.operation, t.outcome, t.error_kind, t.error_message, t.started_at, t.finished_at
             from public.publication_attempts t join public.publication_jobs j on j.id = t.job_id
            where j.interaction_id = ${id} order by t.started_at desc limit 50`,
        tx`select r.id, r.job_id, r.external_reply_id, r.published_content_hash, r.provider_state, r.verified_at
             from public.publication_receipts r join public.publication_jobs j on j.id = r.job_id
            where j.interaction_id = ${id}`,
      ]);
      return {
        interaction,
        permissions: perm,
        versions,
        drafts,
        approvals,
        events,
        jobs,
        attempts,
        receipts,
      };
    });
  });

  // ---------------------------------------------------------------------------
  // Asignación, prioridad, revisión especializada
  // ---------------------------------------------------------------------------
  app.patch('/interactions/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(interactionPatchSchema, req.body);
    return withInteraction(sql, auth, id, 'interactions.update', async (tx, i) => {
      const actor = actorOf(req, auth);
      if (body.assigneeId !== undefined && body.assigneeId !== i.assigneeId) {
        if (body.assigneeId) {
          const [m] = await tx`
            select 1 from public.organization_members m
             where m.organization_id = ${i.organizationId} and m.user_id = ${body.assigneeId} and m.status = 'active'
               and (m.all_clients_access or exists (select 1 from public.client_members cm
                     where cm.client_id = ${i.clientId} and cm.user_id = m.user_id))`;
          if (!m)
            throw new AppError('VALIDATION', 'La persona asignada no tiene acceso a este cliente');
        }
        await tx`update public.external_interactions set assignee_id = ${body.assigneeId} where id = ${id}`;
        await recordEvent(tx, i, 'assigned', actor, {
          data: { from: i.assigneeId, to: body.assigneeId },
        });
      }
      if (body.priority !== undefined && body.priority !== i.priority) {
        await tx`update public.external_interactions set priority = ${body.priority} where id = ${id}`;
        await recordEvent(tx, i, 'priority_changed', actor, {
          data: { from: i.priority, to: body.priority },
        });
      }
      if (
        body.requiresSpecialist !== undefined &&
        body.requiresSpecialist !== i.requiresSpecialist
      ) {
        await tx`update public.external_interactions set requires_specialist = ${body.requiresSpecialist} where id = ${id}`;
        await recordEvent(tx, i, 'specialist_flag_changed', actor, {
          data: { to: body.requiresSpecialist },
        });
      }
      return { ok: true };
    });
  });

  app.post('/interactions/:id/actions', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(interactionActionSchema, req.body);
    if (body.action === 'retry_publish') {
      const r = await withInteraction(
        sql,
        auth,
        id,
        ['responses.publish', 'responses.approve'],
        (tx, i) => retryPublish(tx, i, actorOf(req, auth)),
      );
      if (!r.alreadyQueued) await notify(queue, QUEUES.publish, r.jobId, req.log);
      return { ok: true, jobId: r.jobId };
    }
    const state = await withInteraction(sql, auth, id, 'interactions.update', (tx, i) =>
      applyAction(tx, i, body.action as 'discard', actorOf(req, auth), body.note),
    );
    return { ok: true, state };
  });

  app.post('/organizations/:orgId/interactions/batch', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const body = parse(batchSchema, req.body);
    if (body.action === 'set_priority' && body.priority === undefined) {
      throw new AppError('VALIDATION', 'Indica la prioridad');
    }
    if (body.action === 'assign' && body.assigneeId === undefined) {
      throw new AppError('VALIDATION', 'Indica a quién asignar');
    }
    await withUser(sql, auth, (tx) => requireOrgPermission(tx, auth, orgId, 'organization.read'));
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    // Cada elemento en su propia transacción: un fallo no deshace el resto.
    for (const id of [...new Set(body.ids)]) {
      try {
        await withInteraction(sql, auth, id, 'interactions.update', async (tx, i) => {
          if (i.organizationId !== orgId)
            throw new AppError('NOT_FOUND', 'Interacción no encontrada');
          const actor = actorOf(req, auth);
          if (body.action === 'assign') {
            if (body.assigneeId) {
              const [m] = await tx`
                select 1 from public.organization_members m
                 where m.organization_id = ${orgId} and m.user_id = ${body.assigneeId} and m.status = 'active'
                   and (m.all_clients_access or exists (select 1 from public.client_members cm
                         where cm.client_id = ${i.clientId} and cm.user_id = m.user_id))`;
              if (!m)
                throw new AppError(
                  'VALIDATION',
                  'La persona asignada no tiene acceso a este cliente',
                );
            }
            await tx`update public.external_interactions set assignee_id = ${body.assigneeId ?? null} where id = ${id}`;
            await recordEvent(tx, i, 'assigned', actor, {
              data: { from: i.assigneeId, to: body.assigneeId ?? null, batch: true },
            });
          } else if (body.action === 'set_priority') {
            await tx`update public.external_interactions set priority = ${body.priority!} where id = ${id}`;
            await recordEvent(tx, i, 'priority_changed', actor, {
              data: { from: i.priority, to: body.priority, batch: true },
            });
          } else {
            await applyAction(tx, i, body.action, actor, 'Acción por lotes');
          }
        });
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof AppError ? e.message : 'Error' });
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });

  // ---------------------------------------------------------------------------
  // Borradores y aprobaciones
  // ---------------------------------------------------------------------------
  app.post('/interactions/:id/drafts', async (req, reply) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(draftInputSchema, req.body);
    const r = await withInteraction(sql, auth, id, 'drafts.write', (tx, i) =>
      saveDraft(tx, i, body.content, actorOf(req, auth)),
    );
    return reply.status(r.unchanged ? 200 : 201).send(r);
  });

  app.post('/interactions/:id/request-approval', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const d = await withInteraction(sql, auth, id, 'approvals.request', (tx, i) =>
      requestApproval(tx, i, actorOf(req, auth)),
    );
    return { ok: true, draftId: d.id, version: d.version };
  });

  app.post('/interactions/:id/decision', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(decisionSchema, req.body);
    const r = await withInteraction(sql, auth, id, 'responses.approve', (tx, i) =>
      decide(tx, i, body, actorOf(req, auth)),
    );
    // Aviso al worker DESPUÉS del commit (si se pierde, el barrido lo recupera).
    if (r.jobId) await notify(queue, QUEUES.publish, r.jobId, req.log);
    return r;
  });

  app.get('/organizations/:orgId/approvals', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const q = parse(z.object({ clientId: uuidSchema.optional() }), req.query);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      const items = await tx`
        select i.id, i.client_id, c.name as client_name, i.provider, i.author_display_name, i.content, i.rating, i.rating_scale,
               i.priority, i.risk_flags, i.requires_specialist, i.original_created_at, i.approval_requested_at,
               rp.full_name as approval_requested_by_name, i.is_simulated,
               d.id as draft_id, d.version as draft_version, d.content as draft_content, d.content_hash as draft_hash
          from public.external_interactions i
          join public.clients c on c.id = i.client_id
          left join public.profiles rp on rp.id = i.approval_requested_by
          join lateral (select id, version, content, content_hash from public.response_drafts
                         where interaction_id = i.id order by version desc limit 1) d on true
         where i.organization_id = ${orgId} and i.state = 'pending_approval'
           and (${q.clientId ?? null}::uuid is null or i.client_id = ${q.clientId ?? null}::uuid)
           and private.has_client_permission_in(i.organization_id, i.client_id, 'responses.approve')
         order by i.priority desc, i.approval_requested_at asc
         limit 100`;
      return { items };
    });
  });
}
