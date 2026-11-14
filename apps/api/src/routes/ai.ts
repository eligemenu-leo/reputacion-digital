import type { FastifyInstance } from 'fastify';
import { aiBudgetUpdateSchema, aiDraftRequestSchema, uuidSchema } from '@rep/shared';
import { requireAuth } from '../app';
import { withUser } from '../lib/db';
import { requireOrgPermission } from '../lib/authz';
import { parse } from '../lib/http';
import { notify, QUEUES } from '../domain/queue';
import { audit } from '../domain/workflow';
import {
  budgetStatus,
  generateDraftText,
  loadDraftContext,
  realDataAllowed,
  requestClassification,
  saveAiDraft,
} from '../ai/service';
import { withInteraction } from './interactions';

export async function aiRoutes(app: FastifyInstance) {
  const { sql, queue } = app.deps;
  const idOf = (p: unknown, k: string) => parse(uuidSchema, (p as Record<string, string>)[k]);
  const deps = () => ({ sql, ai: app.deps.ai, queue, log: app.log });

  /**
   * Genera un borrador con IA y lo guarda como nueva versión. NO lo envía a
   * aprobación ni lo publica: sigue el flujo humano normal.
   */
  app.post('/interactions/:id/ai-draft', async (req) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const { variant } = parse(aiDraftRequestSchema, req.body ?? {});
    const actor = { userId: auth.userId, requestId: req.id };
    // 1) Permisos y contexto (transacción corta; no se mantiene abierta durante la llamada al modelo).
    const ctx = await withInteraction(sql, auth, id, 'drafts.write', (tx, row) =>
      loadDraftContext(tx, row, app.deps.ai, variant),
    );
    // 2) Llamada al modelo con presupuesto reservado y validación.
    const gen = await generateDraftText(deps(), ctx, actor);
    // 3) Guardado como borrador (invalida aprobaciones previas como cualquier edición).
    const saved = await withInteraction(sql, auth, id, 'drafts.write', (tx, row) =>
      saveAiDraft(tx, row, gen, actor),
    );
    return {
      draft: saved.draft,
      unchanged: saved.unchanged,
      generation: {
        id: gen.generationId,
        provider: app.deps.ai!.provider.name,
        warnings: gen.warnings,
        toneApplied: gen.toneApplied,
        usedFacts: gen.usedFacts,
      },
    };
  });

  /** Vuelve a pedir la clasificación (p. ej. tras un error o un cambio de modelo). */
  app.post('/interactions/:id/ai-classify', async (req, reply) => {
    const auth = requireAuth(req);
    const id = idOf(req.params, 'id');
    const queued = await withInteraction(sql, auth, id, 'interactions.update', async (tx, row) => {
      const ok = await requestClassification(tx, row.id);
      if (ok) {
        await audit(tx, {
          organizationId: row.organizationId,
          clientId: row.clientId,
          actor: { userId: auth.userId, requestId: req.id },
          action: 'interaction.ai_classify_requested',
          entityType: 'external_interaction',
          entityId: row.id,
        });
      }
      return ok;
    });
    if (queued) await notify(queue, QUEUES.classify, id, req.log);
    return reply.status(202).send({ queued });
  });

  /** Estado de la IA para la organización: proveedor, modelos, presupuesto y consumo del mes. */
  app.get('/organizations/:orgId/ai', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      const budget = await budgetStatus(tx, orgId);
      const [perm] = await tx<{ canManage: boolean }[]>`
        select private.has_org_permission(${orgId}::uuid, 'organization.manage') as can_manage`;
      const byKind = await tx`
        select kind, count(*)::int as calls, coalesce(sum(cost_usd), 0)::float8 as cost_usd
          from public.ai_generations
         where organization_id = ${orgId} and created_at >= date_trunc('month', now()) and status <> 'blocked'
         group by kind`;
      const ai = app.deps.ai;
      return {
        configured: Boolean(ai),
        provider: ai?.provider.name ?? null,
        models: ai?.models ?? null,
        realDataAllowed: await realDataAllowed(tx),
        budget,
        usage: byKind,
        canManage: perm?.canManage ?? false,
      };
    });
  });

  app.patch('/organizations/:orgId/ai/budget', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const input = parse(aiBudgetUpdateSchema, req.body);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.manage');
      await tx.unsafe('set local role service_role');
      const [b] = await tx`
        insert into public.ai_budgets (organization_id, monthly_limit_usd, hard_stop, updated_by)
        values (${orgId}, ${input.monthlyLimitUsd}, ${input.hardStop}, ${auth.userId})
        on conflict (organization_id) do update set monthly_limit_usd = excluded.monthly_limit_usd,
          hard_stop = excluded.hard_stop, updated_by = excluded.updated_by
        returning monthly_limit_usd, hard_stop`;
      await audit(tx, {
        organizationId: orgId,
        actor: { userId: auth.userId, requestId: req.id },
        action: 'ai.budget_updated',
        entityType: 'ai_budget',
        entityId: orgId,
        metadata: input,
      });
      return { monthlyLimitUsd: Number(b!.monthlyLimitUsd), hardStop: b!.hardStop };
    });
  });
}
