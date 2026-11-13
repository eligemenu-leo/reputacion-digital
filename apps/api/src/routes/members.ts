import type { FastifyInstance } from 'fastify';
import { AppError, inviteMemberSchema, updateMemberSchema, uuidSchema } from '@rep/shared';
import { requireAuth } from '../app';
import { withUser } from '../lib/db';
import { requireOrgPermission } from '../lib/authz';
import { parse } from '../lib/http';
import { z } from 'zod';

const auditQuerySchema = z.object({ before: z.coerce.number().int().positive().optional() });

export async function memberRoutes(app: FastifyInstance) {
  const { sql, config, authAdmin } = app.deps;
  const orgParam = (p: unknown) => parse(uuidSchema, (p as { orgId: string }).orgId);

  app.get('/organizations/:orgId/roles', async (req) => {
    const auth = requireAuth(req);
    const orgId = orgParam(req.params);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      return tx`
        select r.id, r.key, r.name, r.description, r.is_system,
               coalesce(array_agg(rp.permission_key order by rp.permission_key) filter (where rp.permission_key is not null), '{}') as permissions
          from public.roles r left join public.role_permissions rp on rp.role_id = r.id
         where r.is_system or r.organization_id = ${orgId}
         group by r.id order by r.is_system desc, r.name`;
    });
  });

  app.get('/organizations/:orgId/members', async (req) => {
    const auth = requireAuth(req);
    const orgId = orgParam(req.params);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      return tx`
        select m.id, m.user_id, m.status, m.all_clients_access, m.created_at,
               p.email, p.full_name, r.id as role_id, r.key as role_key, r.name as role_name,
               (select count(*)::int from public.client_members cm where cm.user_id = m.user_id and cm.organization_id = m.organization_id) as assigned_clients
          from public.organization_members m
          join public.roles r on r.id = m.role_id
          left join public.profiles p on p.id = m.user_id
         where m.organization_id = ${orgId}
         order by coalesce(p.full_name, p.email)`;
    });
  });

  // Invitar/añadir usuario. Si el usuario ya existe en Auth se añade directamente;
  // si no, se envía una invitación real por Supabase Auth (o se rechaza si no está configurado).
  app.post('/organizations/:orgId/members', async (req, reply) => {
    const auth = requireAuth(req);
    const orgId = orgParam(req.params);
    const input = parse(inviteMemberSchema, req.body);

    await withUser(sql, auth, (tx) =>
      requireOrgPermission(tx, auth, orgId, 'members.manage', {
        sensitive: true,
        enforceMfa: config.ENFORCE_ADMIN_MFA,
      }),
    );
    const [existing] = await sql<
      { id: string }[]
    >`select id from auth.users where lower(email) = ${input.email} limit 1`;
    const userId =
      existing?.id ??
      (await authAdmin.inviteUser(input.email, `${config.APP_URL}/auth/callback`)).userId;

    const member = await withUser(sql, auth, async (tx) => {
      const [role] = await tx<{ id: string }[]>`
        select id from public.roles where key = ${input.roleKey} and (is_system or organization_id = ${orgId}) limit 1`;
      if (!role) throw new AppError('VALIDATION', 'Rol no válido');
      const [m] = await tx`
        insert into public.organization_members (organization_id, user_id, role_id, all_clients_access, status, invited_by)
        values (${orgId}, ${userId}, ${role.id}, ${input.allClientsAccess}, ${existing ? 'active' : 'invited'}, ${auth.userId})
        returning id, user_id, role_id, all_clients_access, status`;
      for (const clientId of input.clientIds) {
        await tx`insert into public.client_members (organization_id, client_id, user_id, created_by)
                 values (${orgId}, ${clientId}, ${userId}, ${auth.userId})`;
      }
      return m;
    });
    return reply.status(201).send({ member, invited: !existing });
  });

  app.patch('/organizations/:orgId/members/:memberId', async (req) => {
    const auth = requireAuth(req);
    const orgId = orgParam(req.params);
    const memberId = parse(uuidSchema, (req.params as { memberId: string }).memberId);
    const input = parse(updateMemberSchema, req.body);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'members.manage', {
        sensitive: true,
        enforceMfa: config.ENFORCE_ADMIN_MFA,
      });
      const [m] = await tx`
        update public.organization_members set
          role_id = coalesce(${input.roleId ?? null}::uuid, role_id),
          all_clients_access = coalesce(${input.allClientsAccess ?? null}, all_clients_access),
          status = coalesce(${input.status ?? null}::public.member_status, status)
        where id = ${memberId} and organization_id = ${orgId}
        returning id, user_id, role_id, all_clients_access, status`;
      if (!m) throw new AppError('NOT_FOUND', 'Miembro no encontrado');
      return m;
    });
  });

  app.delete('/organizations/:orgId/members/:memberId', async (req, reply) => {
    const auth = requireAuth(req);
    const orgId = orgParam(req.params);
    const memberId = parse(uuidSchema, (req.params as { memberId: string }).memberId);
    await withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'members.manage', {
        sensitive: true,
        enforceMfa: config.ENFORCE_ADMIN_MFA,
      });
      const r =
        await tx`delete from public.organization_members where id = ${memberId} and organization_id = ${orgId} returning id`;
      if (r.length === 0) throw new AppError('NOT_FOUND', 'Miembro no encontrado');
    });
    return reply.status(204).send();
  });

  app.get('/organizations/:orgId/audit', async (req) => {
    const auth = requireAuth(req);
    const orgId = orgParam(req.params);
    const { before } = parse(auditQuerySchema, req.query);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'audit.read');
      return tx`
        select a.id, a.action, a.entity_type, a.entity_id, a.client_id, a.actor_user_id, a.actor_type,
               a.changes, a.created_at, p.email as actor_email, p.full_name as actor_name
          from public.audit_logs a left join public.profiles p on p.id = a.actor_user_id
         where a.organization_id = ${orgId} and (${before ?? null}::bigint is null or a.id < ${before ?? null}::bigint)
         order by a.id desc limit 100`;
    });
  });
}
