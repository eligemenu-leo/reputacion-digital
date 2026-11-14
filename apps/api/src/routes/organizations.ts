import type { FastifyInstance } from 'fastify';
import {
  AppError,
  createOrganizationSchema,
  updateOrganizationSchema,
  uuidSchema,
} from '@rep/shared';
import { requireAuth } from '../app';
import { withService, withUser } from '../lib/db';
import { requireOrgPermission, requirePlatformAdmin } from '../lib/authz';
import { parse } from '../lib/http';

export async function organizationRoutes(app: FastifyInstance) {
  const { sql, config, authAdmin } = app.deps;

  // Organizaciones visibles para el usuario (RLS decide).
  app.get('/organizations', async (req) => {
    const auth = requireAuth(req);
    return withUser(
      sql,
      auth,
      (tx) => tx`
      select id, name, slug, status, default_locale, default_timezone, publishing_paused, require_admin_mfa, created_at
        from public.organizations order by name`,
    );
  });

  // Alta de organización: solo superadministradores. Crea la organización y
  // asigna (o invita) a su primer administrador en una única transacción.
  app.post('/organizations', async (req, reply) => {
    const auth = requireAuth(req);
    const input = parse(createOrganizationSchema, req.body);
    await withUser(sql, auth, (tx) => requirePlatformAdmin(tx, auth, config.ENFORCE_ADMIN_MFA));

    // Resolver usuario propietario (existente o invitación real vía Supabase Auth).
    const [existing] = await sql<
      { id: string }[]
    >`select id from auth.users where lower(email) = ${input.ownerEmail} limit 1`;
    const ownerId =
      existing?.id ??
      (await authAdmin.inviteUser(input.ownerEmail, `${config.APP_URL}/auth/callback`)).userId;

    const org = await withService(sql, auth, async (tx) => {
      const [o] = await tx`
        insert into public.organizations (name, slug, default_locale, default_timezone, created_by)
        values (${input.name}, ${input.slug}, ${input.defaultLocale}, ${input.defaultTimezone}, ${auth.userId})
        returning id, name, slug, status, default_locale, default_timezone, created_at`;
      await tx`
        insert into public.organization_members (organization_id, user_id, role_id, all_clients_access, status, invited_by)
        select ${o!.id}, ${ownerId}, r.id, true, ${existing ? 'active' : 'invited'}, ${auth.userId}
          from public.roles r where r.key = 'org_admin' and r.is_system`;
      return o;
    });
    return reply.status(201).send({ organization: org, ownerInvited: !existing });
  });

  app.get('/organizations/:orgId', async (req) => {
    const auth = requireAuth(req);
    const orgId = parse(uuidSchema, (req.params as { orgId: string }).orgId);
    return withUser(sql, auth, async (tx) => {
      const [o] = await tx`
        select id, name, slug, status, default_locale, default_timezone, publishing_paused, require_admin_mfa, created_at
          from public.organizations where id = ${orgId}`;
      if (!o) throw new AppError('NOT_FOUND', 'Organización no encontrada');
      return o;
    });
  });

  app.patch('/organizations/:orgId', async (req) => {
    const auth = requireAuth(req);
    const orgId = parse(uuidSchema, (req.params as { orgId: string }).orgId);
    const input = parse(updateOrganizationSchema, req.body);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.manage', {
        sensitive: true,
        enforceMfa: config.ENFORCE_ADMIN_MFA,
      });
      const [o] = await tx`
        update public.organizations set
          name = coalesce(${input.name ?? null}, name),
          default_locale = coalesce(${input.defaultLocale ?? null}, default_locale),
          default_timezone = coalesce(${input.defaultTimezone ?? null}, default_timezone),
          publishing_paused = coalesce(${input.publishingPaused ?? null}, publishing_paused),
          require_admin_mfa = coalesce(${input.requireAdminMfa ?? null}, require_admin_mfa)
        where id = ${orgId}
        returning id, name, slug, status, default_locale, default_timezone, publishing_paused, require_admin_mfa`;
      if (!o) throw new AppError('NOT_FOUND', 'Organización no encontrada');
      return o;
    });
  });

  // Resumen operativo con datos reales. Los módulos aún no implementados se
  // declaran explícitamente como no disponibles: no se inventan métricas.
  app.get('/organizations/:orgId/overview', async (req) => {
    const auth = requireAuth(req);
    const orgId = parse(uuidSchema, (req.params as { orgId: string }).orgId);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'organization.read');
      const [counts] = await tx`
        select
          (select count(*)::int from public.clients c where c.organization_id = ${orgId} and c.status <> 'archived') as clients_total,
          (select count(*)::int from public.clients c where c.organization_id = ${orgId} and c.status = 'active') as clients_active,
          (select count(*)::int from public.clients c where c.organization_id = ${orgId} and c.status = 'onboarding') as clients_onboarding,
          (select count(*)::int from public.client_locations l where l.organization_id = ${orgId} and l.is_active) as locations_active,
          (select count(*)::int from public.organization_members m where m.organization_id = ${orgId} and m.status = 'active') as members_active`;
      const [inbox] = await tx`
        select count(*) filter (where state not in ('published', 'discarded', 'closed_no_response'))::int as open,
               count(*) filter (where state not in ('published', 'discarded', 'closed_no_response') and priority >= 3)::int as high_priority,
               count(*) filter (where state = 'pending_approval')::int as pending_approval,
               count(*) filter (where state = 'publish_failed')::int as publish_failed,
               count(*) filter (where state = 'published' and responded_at > now() - interval '7 days')::int as published_7d,
               count(*) filter (where original_created_at > now() - interval '7 days')::int as received_7d,
               count(*) filter (where is_simulated)::int as simulated
          from public.external_interactions where organization_id = ${orgId}`;
      const [sources] = await tx`
        select count(*)::int as total,
               count(*) filter (where status = 'connected')::int as connected,
               count(*) filter (where status in ('credentials_expired', 'insufficient_access', 'temporary_error'))::int as with_errors,
               count(*) filter (where is_simulated)::int as simulated
          from public.connected_accounts where organization_id = ${orgId} and status <> 'disconnected'`;
      const recentClients = await tx`
        select id, name, status, created_at from public.clients
         where organization_id = ${orgId} order by created_at desc limit 5`;
      return {
        counts,
        inbox,
        sources,
        recentClients,
        modules: {
          connectedSources: { status: 'simulator_only', availableIn: 'phase_4' },
          inbox: { status: 'available' },
          approvals: { status: 'available' },
          alerts: { status: 'not_available', availableIn: 'phase_5' },
          sentiment: app.deps.ai
            ? { status: app.deps.ai.provider.name === 'fake' ? 'simulator_only' : 'available' }
            : { status: 'not_available', reason: 'not_configured' },
        },
      };
    });
  });
}
