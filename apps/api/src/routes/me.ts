import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localeSchema, timezoneSchema } from '@rep/shared';
import { requireAuth } from '../app';
import { withService, withUser } from '../lib/db';
import { isPlatformAdmin } from '../lib/authz';
import { parse } from '../lib/http';

const updateProfileSchema = z
  .object({
    fullName: z.string().trim().max(200).nullable(),
    locale: localeSchema,
    timezone: timezoneSchema,
  })
  .partial()
  .strict();

export async function meRoutes(app: FastifyInstance) {
  const { sql } = app.deps;

  app.get('/me', async (req) => {
    const auth = requireAuth(req);
    // Una sesión válida demuestra el control del email invitado: las invitaciones
    // pendientes pasan a activas (nunca se reactiva a un miembro suspendido).
    await withService(
      sql,
      auth,
      (tx) => tx`
      update public.organization_members set status = 'active'
       where user_id = ${auth.userId} and status = 'invited'`,
    );
    return withUser(sql, auth, async (tx) => {
      const [profile] =
        await tx`select id, email, full_name, avatar_url, locale, timezone from public.profiles where id = ${auth.userId}`;
      const memberships = await tx`
        select m.organization_id, o.name as organization_name, o.slug as organization_slug,
               m.all_clients_access, m.status, r.key as role_key, r.name as role_name,
               coalesce(array_agg(rp.permission_key order by rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
          from public.organization_members m
          join public.organizations o on o.id = m.organization_id
          join public.roles r on r.id = m.role_id
          left join public.role_permissions rp on rp.role_id = r.id
         where m.user_id = ${auth.userId} and m.status = 'active' and o.status = 'active'
         group by m.id, o.id, r.id
         order by o.name`;
      return {
        user: { id: auth.userId, email: auth.email, aal: auth.aal },
        profile: profile ?? null,
        isPlatformAdmin: await isPlatformAdmin(tx),
        memberships,
      };
    });
  });

  app.patch('/me/profile', async (req) => {
    const auth = requireAuth(req);
    const input = parse(updateProfileSchema, req.body);
    return withUser(sql, auth, async (tx) => {
      const [row] = await tx`
        update public.profiles set
          full_name = case when ${input.fullName !== undefined} then ${input.fullName ?? null} else full_name end,
          locale = coalesce(${input.locale ?? null}, locale),
          timezone = coalesce(${input.timezone ?? null}, timezone)
        where id = ${auth.userId}
        returning id, email, full_name, avatar_url, locale, timezone`;
      return row;
    });
  });
}
