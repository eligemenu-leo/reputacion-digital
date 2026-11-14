import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SimulatorConnector, type SimulatorConfig } from '@rep/connectors';
import {
  AppError,
  simulatorConfigSchema,
  simulatorConnectionSchema,
  uuidSchema,
} from '@rep/shared';
import { z } from 'zod';
import { requireAuth } from '../app';
import { elevate, withUser, type Sql, type Tx } from '../lib/db';
import { requireClientAction, requireOrgPermission } from '../lib/authz';
import { parse } from '../lib/http';
import type { AuthContext } from '../lib/auth';
import { assertSimulatorAllowed } from '../domain/connectors';
import { releaseCredential } from '../domain/connection-lifecycle';
import { DbSimulatorStore } from '../domain/simulator-store';
import { notify, QUEUES } from '../domain/queue';
import { enqueueSync } from '../domain/sync';
import { audit } from '../domain/workflow';

const ACCOUNT_COLS = `a.id, a.organization_id, a.client_id, c.name as client_name, a.location_id, l.name as location_name,
  a.provider, a.display_name, a.status, a.is_simulated, a.capabilities, a.authorized_at, a.last_success_sync_at,
  a.last_attempt_at, a.next_run_at, a.last_error_kind, a.last_error_message, a.disconnected_at, a.created_at`;

async function withAccount<T>(
  sql: Sql,
  auth: AuthContext,
  id: string,
  fn: (
    tx: Tx,
    a: {
      id: string;
      organizationId: string;
      clientId: string;
      provider: string;
      status: string;
      config: SimulatorConfig;
    },
  ) => Promise<T>,
) {
  return withUser(sql, auth, async (tx) => {
    const [vis] = await tx<
      { clientId: string }[]
    >`select client_id from public.connected_accounts where id = ${id}`;
    if (!vis) throw new AppError('NOT_FOUND', 'Fuente no encontrada');
    await requireClientAction(tx, vis.clientId, 'connections.manage');
    await elevate(tx);
    const [a] = await tx<
      {
        id: string;
        organizationId: string;
        clientId: string;
        provider: string;
        status: string;
        config: SimulatorConfig;
      }[]
    >`
      select id, organization_id, client_id, provider, status, config from public.connected_accounts where id = ${id} for update`;
    return fn(tx, a!);
  });
}

export async function connectionRoutes(app: FastifyInstance) {
  const { sql, queue, config, integrations } = app.deps;
  const store = new DbSimulatorStore(sql);
  const idOf = (p: unknown, k: string) => parse(uuidSchema, (p as Record<string, string>)[k]);

  app.get('/organizations/:orgId/connections', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const q = parse(z.object({ clientId: uuidSchema.optional() }), req.query);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      const items = await tx`
        select ${tx.unsafe(ACCOUNT_COLS)},
               (select jsonb_build_object('id', s.id, 'status', s.status, 'trigger', s.trigger, 'startedAt', s.started_at,
                         'finishedAt', s.finished_at, 'itemsFound', s.items_found, 'itemsCreated', s.items_created,
                         'itemsUpdated', s.items_updated, 'errorCount', s.error_count, 'failureKind', s.failure_kind,
                         'failureReason', s.failure_reason, 'createdAt', s.created_at)
                  from public.provider_sync_runs s where s.connected_account_id = a.id
                 order by s.created_at desc limit 1) as last_run,
               private.has_client_permission_in(a.organization_id, a.client_id, 'connections.manage') as can_manage
          from public.connected_accounts a
          join public.clients c on c.id = a.client_id
          left join public.client_locations l on l.id = a.location_id
         where a.organization_id = ${orgId}
           and (${q.clientId ?? null}::uuid is null or a.client_id = ${q.clientId ?? null}::uuid)
         order by c.name, a.created_at`;
      return { items, simulatorAvailable: config.NODE_ENV !== 'production' };
    });
  });

  /** Alta de una fuente SIMULADA (solo fuera de producción). Los datos que genera son ficticios. */
  app.post('/organizations/:orgId/connections/simulator', async (req, reply) => {
    assertSimulatorAllowed(config.NODE_ENV);
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const body = parse(simulatorConnectionSchema, req.body);
    const created = await withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, body.clientId, 'connections.manage');
      const [c] =
        await tx`select 1 from public.clients where id = ${body.clientId} and organization_id = ${orgId}`;
      if (!c) throw new AppError('NOT_FOUND', 'Cliente no encontrado');
      await elevate(tx);
      const cfg = { publishMode: body.publishMode, syncMode: body.syncMode };
      const [a] = await tx<{ id: string }[]>`
        insert into public.connected_accounts
          (organization_id, client_id, location_id, provider, external_account_id, display_name, status, is_simulated,
           granted_scopes, capabilities, config, authorized_at, authorized_by, next_run_at)
        values (${orgId}, ${body.clientId}, ${body.locationId ?? null}, 'simulator', ${'sim-' + randomUUID()},
                ${body.displayName}, 'connected', true, ${['simulator']},
                ${['fetch_interactions', 'read_existing_replies', 'publish_reply', 'publication_status']},
                ${tx.json(cfg)}, now(), ${auth.userId}, now() + interval '60 minutes')
        returning id`;
      return a!;
    });
    return reply.status(201).send(created);
  });

  app.patch('/connections/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(simulatorConfigSchema, req.body);
    return withAccount(sql, auth, id, async (tx, a) => {
      if (a.provider !== 'simulator')
        throw new AppError('VALIDATION', 'Solo las fuentes simuladas tienen modos de prueba');
      const cfg = { ...a.config, ...body };
      await tx`update public.connected_accounts set config = ${tx.json(cfg as never)},
                 status = case when status = 'disconnected' then status else 'connected'::public.connection_status end,
                 last_error_kind = null, last_error_message = null
               where id = ${id}`;
      return { ok: true, config: cfg };
    });
  });

  app.post('/connections/:id/simulate-reviews', async (req) => {
    assertSimulatorAllowed(config.NODE_ENV);
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(
      z
        .object({
          count: z.number().int().min(1).max(50).default(5),
          backdateDays: z.number().int().min(0).max(365).default(0),
        })
        .strict(),
      req.body ?? {},
    );
    const a = await withAccount(sql, auth, id, async (_tx, a) => a);
    if (a.provider !== 'simulator')
      throw new AppError('VALIDATION', 'Solo disponible para fuentes simuladas');
    const start = await store.count(id);
    const n = await new SimulatorConnector(store, id).simulateNewReviews(
      body.count,
      start,
      body.backdateDays,
    );
    return { generated: n, totalInProvider: start + n };
  });

  app.post('/connections/:id/simulate-edit', async (req) => {
    assertSimulatorAllowed(config.NODE_ENV);
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const body = parse(
      z
        .object({
          externalId: z.string().min(1).max(100),
          content: z.string().trim().min(1).max(5000),
          rating: z.number().int().min(1).max(5).nullable().default(null),
        })
        .strict(),
      req.body,
    );
    const a = await withAccount(sql, auth, id, async (_tx, a) => a);
    if (a.provider !== 'simulator')
      throw new AppError('VALIDATION', 'Solo disponible para fuentes simuladas');
    if (!(await store.editItem(id, body.externalId, body.content, body.rating))) {
      throw new AppError('NOT_FOUND', 'Reseña simulada no encontrada');
    }
    return { ok: true };
  });

  app.post('/connections/:id/sync', async (req, reply) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const r = await withAccount(sql, auth, id, async (tx, a) => {
      if (a.status === 'disconnected')
        throw new AppError('CONFLICT', 'La fuente está desconectada');
      const run = await enqueueSync(tx, id, 'manual', auth.userId);
      return run;
    });
    if (r.created) await notify(queue, QUEUES.sync, r.runId, req.log);
    return reply.status(r.created ? 202 : 200).send(r);
  });

  app.post('/connections/:id/disconnect', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const res = await withAccount(sql, auth, id, async (tx, a) => {
      const [prev] = await tx<{ credentialId: string | null }[]>`
        select credential_id from public.connected_accounts where id = ${id}`;
      await tx`update public.connected_accounts set status = 'disconnected', disconnected_at = now(), next_run_at = null,
                 credential_id = null where id = ${id}`;
      await tx`update public.provider_sync_runs set status = 'cancelled', finished_at = now(), cancelled_by = ${auth.userId}
                where connected_account_id = ${id} and status = 'queued'`;
      await audit(tx, {
        organizationId: a.organizationId,
        clientId: a.clientId,
        actor: { userId: auth.userId, requestId: req.id },
        action: 'connection.disconnect',
        entityType: 'connected_accounts',
        entityId: id,
      });
      return { credentialId: prev?.credentialId ?? null };
    });
    // Si era la última fuente con esa autorización, se revoca en el proveedor y se borra.
    const released = res.credentialId
      ? await releaseCredential(sql, integrations, res.credentialId)
      : { released: false, revokedAtProvider: null };
    return {
      ok: true,
      credentialReleased: released.released,
      revokedAtProvider: released.revokedAtProvider,
    };
  });

  app.get('/connections/:id/runs', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    return withUser(sql, auth, async (tx) => {
      const [vis] = await tx`select 1 from public.connected_accounts where id = ${id}`;
      if (!vis) throw new AppError('NOT_FOUND', 'Fuente no encontrada');
      const items = await tx`
        select s.id, s.status, s.trigger, s.requested_by, p.full_name as requested_by_name, s.started_at, s.finished_at,
               s.items_found, s.items_created, s.items_updated, s.error_count, s.failure_kind, s.failure_reason, s.created_at
          from public.provider_sync_runs s left join public.profiles p on p.id = s.requested_by
         where s.connected_account_id = ${id} order by s.created_at desc limit 50`;
      return { items };
    });
  });

  app.post('/sync-runs/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    return withUser(sql, auth, async (tx) => {
      const [run] = await tx<
        { clientId: string }[]
      >`select client_id from public.provider_sync_runs where id = ${id}`;
      if (!run) throw new AppError('NOT_FOUND', 'Sincronización no encontrada');
      await requireClientAction(tx, run.clientId, 'connections.manage');
      await elevate(tx);
      const r = await tx`
        update public.provider_sync_runs set status = 'cancelled', finished_at = now(), cancelled_by = ${auth.userId}
         where id = ${id} and status in ('queued', 'running') returning connected_account_id`;
      if (!r.length) throw new AppError('CONFLICT', 'La sincronización ya ha terminado');
      await tx`update public.connected_accounts set status = 'connected' where id = ${(r[0] as { connectedAccountId: string }).connectedAccountId} and status = 'syncing'`;
      return { ok: true };
    });
  });
}
