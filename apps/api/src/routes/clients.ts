import type { FastifyInstance } from 'fastify';
import {
  AppError,
  assignClientMemberSchema,
  clientInputSchema,
  clientUpdateSchema,
  listQuerySchema,
  locationInputSchema,
  locationUpdateSchema,
  uuidSchema,
} from '@rep/shared';
import { requireAuth } from '../app';
import { withUser, type Tx } from '../lib/db';
import { requireClientAction, requireClientPermission, requireOrgPermission } from '../lib/authz';
import { parse } from '../lib/http';

const CLIENT_COLUMNS = `id, organization_id, name, legal_name, sector, description, logo_path, website, phone,
  primary_language, timezone, account_manager_id, status, onboarded_at, business_context, ai_enabled,
  created_at, updated_at, archived_at`;

const LOCATION_COLUMNS = `id, client_id, name, address_line, city, region, postal_code, country_code, phone,
  timezone, is_primary, is_active, created_at, updated_at`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/** Quita claves undefined para construir UPDATE dinámicos solo con lo enviado. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function getOrgOfClient(tx: Tx, clientId: string): Promise<string> {
  const [c] = await tx<
    { organizationId: string }[]
  >`select organization_id from public.clients where id = ${clientId}`;
  if (!c) throw new AppError('NOT_FOUND', 'Cliente no encontrado');
  return c.organizationId;
}

export async function clientRoutes(app: FastifyInstance) {
  const { sql } = app.deps;
  const idOf = (p: unknown, k: string) => parse(uuidSchema, (p as Record<string, string>)[k]);

  app.get('/organizations/:orgId/clients', async (req) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const q = parse(listQuerySchema, req.query);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      const search = q.q ? `%${escapeLike(q.q)}%` : null;
      const order = { name: 'lower(c.name)', created_at: 'c.created_at', status: 'c.status' }[
        q.sort
      ];
      const dir = q.dir === 'desc' ? 'desc' : 'asc';
      // RLS filtra los clientes a los que el usuario tiene acceso.
      const rows = await tx`
        select c.id, c.name, c.sector, c.status, c.website, c.primary_language, c.timezone, c.onboarded_at, c.created_at,
               c.account_manager_id, p.full_name as account_manager_name, p.email as account_manager_email,
               (select count(*)::int from public.client_locations l where l.client_id = c.id and l.is_active) as locations_count,
               count(*) over()::int as total_count
          from public.clients c
          left join public.profiles p on p.id = c.account_manager_id
         where c.organization_id = ${orgId}
           and (${q.status ?? null}::public.client_status is null or c.status = ${q.status ?? null}::public.client_status)
           and (${q.status ?? null}::public.client_status is not null or c.status <> 'archived')
           and (${search}::text is null or c.name ilike ${search} or c.legal_name ilike ${search} or c.sector ilike ${search})
         order by ${tx.unsafe(order)} ${tx.unsafe(dir)}, c.id
         limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`;
      const total = (rows[0] as { totalCount?: number } | undefined)?.totalCount ?? 0;
      return {
        items: rows.map(({ totalCount: _t, ...r }) => r),
        page: q.page,
        pageSize: q.pageSize,
        total,
      };
    });
  });

  app.post('/organizations/:orgId/clients', async (req, reply) => {
    const auth = requireAuth(req);
    const orgId = idOf(req.params, 'orgId');
    const input = parse(clientInputSchema, req.body);
    const client = await withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'clients.create');
      const row = defined({ ...input, organizationId: orgId, createdBy: auth.userId });
      const [c] =
        await tx`insert into public.clients ${tx(row)} returning ${tx.unsafe(CLIENT_COLUMNS)}`;
      return c;
    });
    return reply.status(201).send(client);
  });

  app.get('/clients/:clientId', async (req) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    return withUser(sql, auth, async (tx) => {
      await requireClientPermission(tx, clientId, 'clients.read');
      const [c] =
        await tx`select ${tx.unsafe(CLIENT_COLUMNS)} from public.clients where id = ${clientId}`;
      const locations = await tx`select ${tx.unsafe(LOCATION_COLUMNS)} from public.client_locations
                                  where client_id = ${clientId} order by is_primary desc, name`;
      const members = await tx`
        select cm.id, cm.user_id, p.email, p.full_name, r.key as extra_role_key, r.name as extra_role_name
          from public.client_members cm
          left join public.profiles p on p.id = cm.user_id
          left join public.roles r on r.id = cm.role_id
         where cm.client_id = ${clientId} order by coalesce(p.full_name, p.email)`;
      const [perms] = await tx<{ canUpdate: boolean; canManageMembers: boolean }[]>`
        select private.has_client_permission(${clientId}::uuid, 'clients.update') as can_update,
               private.has_org_permission(${c!.organizationId as string}::uuid, 'members.manage') as can_manage_members`;
      return { ...c, locations, members, permissions: perms };
    });
  });

  app.patch('/clients/:clientId', async (req) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const input = parse(clientUpdateSchema, req.body);
    return withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'clients.update');
      const patch: Record<string, unknown> = defined(input);
      if (input.status) patch.archivedAt = input.status === 'archived' ? new Date() : null;
      if (Object.keys(patch).length === 0) throw new AppError('VALIDATION', 'Nada que actualizar');
      const [c] =
        await tx`update public.clients set ${tx(patch)} where id = ${clientId} returning ${tx.unsafe(CLIENT_COLUMNS)}`;
      return c;
    });
  });

  // ---------------- Ubicaciones ----------------
  app.post('/clients/:clientId/locations', async (req, reply) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const input = parse(locationInputSchema, req.body);
    const loc = await withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'clients.update');
      const orgId = await getOrgOfClient(tx, clientId);
      if (input.isPrimary)
        await tx`update public.client_locations set is_primary = false where client_id = ${clientId} and is_primary`;
      const [l] =
        await tx`insert into public.client_locations ${tx(defined({ ...input, organizationId: orgId, clientId }))}
                           returning ${tx.unsafe(LOCATION_COLUMNS)}`;
      return l;
    });
    return reply.status(201).send(loc);
  });

  app.patch('/clients/:clientId/locations/:locationId', async (req) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const locationId = idOf(req.params, 'locationId');
    const input = parse(locationUpdateSchema, req.body);
    return withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'clients.update');
      const patch = defined(input);
      if (Object.keys(patch).length === 0) throw new AppError('VALIDATION', 'Nada que actualizar');
      if (input.isPrimary) {
        await tx`update public.client_locations set is_primary = false where client_id = ${clientId} and is_primary and id <> ${locationId}`;
      }
      const [l] = await tx`update public.client_locations set ${tx(patch)}
                            where id = ${locationId} and client_id = ${clientId} returning ${tx.unsafe(LOCATION_COLUMNS)}`;
      if (!l) throw new AppError('NOT_FOUND', 'Ubicación no encontrada');
      return l;
    });
  });

  app.delete('/clients/:clientId/locations/:locationId', async (req, reply) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const locationId = idOf(req.params, 'locationId');
    await withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'clients.update');
      const r =
        await tx`delete from public.client_locations where id = ${locationId} and client_id = ${clientId} returning id`;
      if (r.length === 0) throw new AppError('NOT_FOUND', 'Ubicación no encontrada');
    });
    return reply.status(204).send();
  });

  // ---------------- Asignación de usuarios ----------------
  app.post('/clients/:clientId/members', async (req, reply) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const input = parse(assignClientMemberSchema, req.body);
    const row = await withUser(sql, auth, async (tx) => {
      await requireClientPermission(tx, clientId, 'clients.read');
      const orgId = await getOrgOfClient(tx, clientId);
      await requireOrgPermission(tx, auth, orgId, 'members.manage', {
        sensitive: true,
        enforceMfa: app.deps.config.ENFORCE_ADMIN_MFA,
      });
      let roleId: string | null = null;
      if (input.extraRoleKey) {
        const [r] = await tx<
          { id: string }[]
        >`select id from public.roles where key = ${input.extraRoleKey}
                                                and (is_system or organization_id = ${orgId}) limit 1`;
        if (!r) throw new AppError('VALIDATION', 'Rol no válido');
        roleId = r.id;
      }
      const [cm] = await tx`
        insert into public.client_members (organization_id, client_id, user_id, role_id, created_by)
        values (${orgId}, ${clientId}, ${input.userId}, ${roleId}, ${auth.userId})
        on conflict (client_id, user_id) do update set role_id = excluded.role_id
        returning id, client_id, user_id, role_id`;
      return cm;
    });
    return reply.status(201).send(row);
  });

  app.delete('/clients/:clientId/members/:userId', async (req, reply) => {
    const auth = requireAuth(req);
    const clientId = idOf(req.params, 'clientId');
    const userId = idOf(req.params, 'userId');
    await withUser(sql, auth, async (tx) => {
      await requireClientPermission(tx, clientId, 'clients.read');
      const orgId = await getOrgOfClient(tx, clientId);
      await requireOrgPermission(tx, auth, orgId, 'members.manage', {
        sensitive: true,
        enforceMfa: app.deps.config.ENFORCE_ADMIN_MFA,
      });
      const r =
        await tx`delete from public.client_members where client_id = ${clientId} and user_id = ${userId} returning id`;
      if (r.length === 0) throw new AppError('NOT_FOUND', 'Asignación no encontrada');
    });
    return reply.status(204).send();
  });
}
