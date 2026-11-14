import type { FastifyInstance } from 'fastify';
import { AppError, brandVersionInputSchema, uuidSchema } from '@rep/shared';
import { requireAuth } from '../app';
import { withUser } from '../lib/db';
import { requireClientAction, requireClientPermission } from '../lib/authz';
import { parse } from '../lib/http';

const VERSION_COLUMNS = `v.id, v.version, v.tone, v.formality, v.address_form, v.response_language,
  v.recommended_expressions, v.forbidden_expressions, v.emoji_policy, v.preferred_length, v.approved_examples,
  v.extra_instructions, v.verified_business_info, v.change_note, v.created_by, v.created_at`;

/**
 * Personalidad de marca. Cada guardado crea una versión NUEVA e inmutable y la
 * marca como vigente; las generaciones de IA guardan qué versión usaron.
 * Se escribe como el usuario (RLS: permiso brand.write).
 */
export async function brandRoutes(app: FastifyInstance) {
  const { sql } = app.deps;
  const idOf = (p: unknown, k: string) => parse(uuidSchema, (p as Record<string, string>)[k]);

  app.get('/clients/:clientId/brand', async (req) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    return withUser(sql, auth, async (tx) => {
      await requireClientPermission(tx, clientId, 'clients.read');
      const [current] = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)}, pr.full_name as created_by_name
          from public.brand_profiles p
          join public.brand_profile_versions v on v.id = p.current_version_id
          left join public.profiles pr on pr.id = v.created_by
         where p.client_id = ${clientId}`;
      const history = await tx`
        select v.id, v.version, v.change_note, v.created_at, pr.full_name as created_by_name
          from public.brand_profile_versions v left join public.profiles pr on pr.id = v.created_by
         where v.client_id = ${clientId} order by v.version desc limit 50`;
      const [perm] = await tx<{ canEdit: boolean }[]>`
        select private.has_client_permission(${clientId}::uuid, 'brand.write') as can_edit`;
      return { current: current ?? null, history, canEdit: perm?.canEdit ?? false };
    });
  });

  app.post('/clients/:clientId/brand', async (req, reply) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const input = parse(brandVersionInputSchema, req.body);
    const created = await withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'brand.write');
      const [c] = await tx<{ organizationId: string }[]>`
        select organization_id from public.clients where id = ${clientId}`;
      if (!c) throw new AppError('NOT_FOUND', 'Cliente no encontrado');
      // Serializa guardados simultáneos del mismo cliente.
      await tx`select pg_advisory_xact_lock(hashtextextended(${'brand:' + clientId}, 0))`;
      await tx`
        insert into public.brand_profiles (organization_id, client_id) values (${c.organizationId}, ${clientId})
        on conflict (client_id) do nothing`;
      const [p] = await tx<
        { id: string }[]
      >`select id from public.brand_profiles where client_id = ${clientId}`;
      const [n] = await tx<{ next: number }[]>`
        select coalesce(max(version), 0) + 1 as next from public.brand_profile_versions where brand_profile_id = ${p!.id}`;
      const [v] = await tx<{ id: string; version: number }[]>`
        insert into public.brand_profile_versions
          (organization_id, client_id, brand_profile_id, version, tone, formality, address_form, response_language,
           recommended_expressions, forbidden_expressions, emoji_policy, preferred_length, approved_examples,
           extra_instructions, verified_business_info, change_note, created_by)
        values (${c.organizationId}, ${clientId}, ${p!.id}, ${n!.next}, ${input.tone}, ${input.formality},
                ${input.addressForm}, ${input.responseLanguage}, ${input.recommendedExpressions},
                ${input.forbiddenExpressions}, ${input.emojiPolicy}, ${input.preferredLength},
                ${tx.json(input.approvedExamples as never)}, ${input.extraInstructions},
                ${tx.json(input.verifiedBusinessInfo as never)}, ${input.changeNote}, ${auth.userId})
        returning id, version`;
      await tx`update public.brand_profiles set current_version_id = ${v!.id} where id = ${p!.id}`;
      return v!;
    });
    return reply.status(201).send(created);
  });
}
