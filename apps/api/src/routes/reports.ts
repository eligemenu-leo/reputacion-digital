import type { FastifyInstance } from 'fastify';
import { AppError, reportPeriodSchema, uuidSchema } from '@rep/shared';
import { requireAuth } from '../app';
import { withUser } from '../lib/db';
import { requireClientAction, requireClientPermission } from '../lib/authz';
import { parse } from '../lib/http';
import { computeMetrics } from '../domain/metrics';
import { audit } from '../domain/workflow';
import { assertPeriod, createReport } from '../ai/reports';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function period(q: unknown) {
  const p = parse(reportPeriodSchema, q ?? {});
  const to = p.to ?? today();
  const from = p.from ?? daysAgo(29);
  assertPeriod(from, to);
  return { from, to };
}

/**
 * Informes por cliente. Métricas observadas (lectura, `reports.read`) y
 * creación de informes con resumen de IA (`reports.read` + `clients.update`,
 * porque consume presupuesto de IA).
 */
export async function reportRoutes(app: FastifyInstance) {
  const { sql, queue } = app.deps;
  const idOf = (p: unknown, k: string) => parse(uuidSchema, (p as Record<string, string>)[k]);

  app.get('/clients/:clientId/insights', async (req) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const { from, to } = period(req.query);
    return withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'reports.read');
      const [perm] = await tx<{ canCreate: boolean }[]>`
        select private.has_client_permission(${clientId}::uuid, 'clients.update') as can_create`;
      return {
        metrics: await computeMetrics(tx, clientId, from, to),
        canCreateReport: perm?.canCreate ?? false,
      };
    });
  });

  app.post('/clients/:clientId/reports', async (req, reply) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const { from, to } = period(req.body);
    const ctx = await withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'reports.read');
      await requireClientAction(tx, clientId, 'clients.update');
      const [c] = await tx<{ organizationId: string; name: string }[]>`
        select organization_id, name from public.clients where id = ${clientId}`;
      if (!c) throw new AppError('NOT_FOUND', 'Cliente no encontrado');
      return {
        organizationId: c.organizationId,
        clientId,
        clientName: c.name,
        userId: auth.userId,
      };
    });
    const r = await createReport({ sql, ai: app.deps.ai, queue, log: req.log }, ctx, from, to);
    await withUser(sql, auth, async (tx) => {
      await tx.unsafe('set local role service_role');
      await audit(tx, {
        organizationId: ctx.organizationId,
        clientId,
        actor: { userId: auth.userId, requestId: req.id },
        action: 'report.created',
        entityType: 'report_snapshot',
        entityId: r.id,
        metadata: { from, to, status: r.status },
      });
    });
    return reply.status(201).send(r);
  });

  app.get('/clients/:clientId/reports', async (req) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    return withUser(sql, auth, async (tx) => {
      await requireClientPermission(tx, clientId, 'reports.read');
      return tx`
        select r.id, r.period_start::text, r.period_end::text, r.status, r.status_reason, r.created_at,
               r.summary->>'headline' as headline, (r.metrics->>'total')::int as total, p.full_name as created_by_name
          from public.report_snapshots r left join public.profiles p on p.id = r.created_by
         where r.client_id = ${clientId} order by r.created_at desc limit 50`;
    });
  });

  app.get('/reports/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    return withUser(sql, auth, async (tx) => {
      // RLS: solo visible con reports.read sobre el cliente.
      const [r] = await tx`
        select r.id, r.client_id, c.name as client_name, r.period_start::text, r.period_end::text, r.status,
               r.status_reason, r.metrics, r.summary, r.warnings, r.created_at, p.full_name as created_by_name,
               g.cost_usd
          from public.report_snapshots r join public.clients c on c.id = r.client_id
          left join public.profiles p on p.id = r.created_by
          left join public.ai_generations g on g.id = r.ai_generation_id
         where r.id = ${id}`;
      if (!r) throw new AppError('NOT_FOUND', 'Informe no encontrado');
      return r;
    });
  });
}
