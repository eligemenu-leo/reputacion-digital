import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@rep/shared';
import { asUser, db, expectSqlError, seedWorld, type Db, type World } from '../fixtures';

let sql: Db;
let w: World;

beforeAll(async () => {
  sql = db();
  w = await seedWorld(sql);
});
afterAll(async () => {
  await sql.end();
});

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

describe('RLS · aislamiento entre organizaciones', () => {
  it('un administrador de B no ve nada de la organización A', async () => {
    await asUser(sql, w.users.adminB, async (tx) => {
      expect(await tx`select id from public.organizations where id = ${w.orgA}`).toHaveLength(0);
      expect(
        await tx`select id from public.clients where organization_id = ${w.orgA}`,
      ).toHaveLength(0);
      expect(
        await tx`select id from public.client_locations where organization_id = ${w.orgA}`,
      ).toHaveLength(0);
      expect(
        await tx`select id from public.organization_members where organization_id = ${w.orgA}`,
      ).toHaveLength(0);
      expect(
        await tx`select id from public.client_members where organization_id = ${w.orgA}`,
      ).toHaveLength(0);
      expect(
        await tx`select id from public.audit_logs where organization_id = ${w.orgA}`,
      ).toHaveLength(0);
      expect(await tx`select id from public.profiles where id = ${w.users.adminA}`).toHaveLength(0);
      expect(await tx`select id from public.roles where organization_id = ${w.orgA}`).toHaveLength(
        0,
      );
    });
  });

  it('un administrador de A no ve los roles personalizados de B', async () => {
    await asUser(sql, w.users.adminA, async (tx) => {
      expect(await tx`select id from public.roles where id = ${w.customRoleB}`).toHaveLength(0);
    });
  });

  it('un administrador de B no puede crear clientes en A', async () => {
    await expectSqlError(
      asUser(
        sql,
        w.users.adminB,
        (tx) =>
          tx`insert into public.clients (organization_id, name) values (${w.orgA}, 'Intruso')`,
      ),
      '42501',
    );
  });

  it('las actualizaciones a filas ajenas no afectan a nada', async () => {
    const r = await asUser(
      sql,
      w.users.adminB,
      (tx) => tx`update public.clients set name = 'hack' where id = ${w.clientA1} returning id`,
    );
    expect(r).toHaveLength(0);
    const [c] = await sql`select name from public.clients where id = ${w.clientA1}`;
    expect(c!.name).toBe('Restaurante Alfa');
  });

  it('no se puede mover un cliente a otra organización', async () => {
    // organization_id no está en la lista de columnas actualizables...
    await expectSqlError(
      asUser(
        sql,
        w.users.adminA,
        (tx) => tx`update public.clients set organization_id = ${w.orgB} where id = ${w.clientA1}`,
      ),
      '42501',
    );
    // ...y aunque lo estuviera, el trigger lo impide incluso para service_role.
    await expectSqlError(
      sql.begin(async (tx) => {
        await tx.unsafe('set local role service_role');
        await tx`update public.clients set organization_id = ${w.orgB} where id = ${w.clientA1}`;
      }),
      '42501',
    );
  });

  it('las FK compuestas impiden mezclar organización y cliente', async () => {
    // Ubicación de un cliente de B declarada como de A.
    await expectSqlError(
      sql`insert into public.client_locations (organization_id, client_id, name) values (${w.orgA}, ${w.clientB1}, 'x')`,
      '23503',
    );
    // Asignar a un cliente de A un usuario que solo pertenece a B.
    await expectSqlError(
      sql`insert into public.client_members (organization_id, client_id, user_id) values (${w.orgA}, ${w.clientA1}, ${w.users.adminB})`,
      '23503',
    );
    // Responsable de cuenta que no es miembro de la organización.
    await expectSqlError(
      sql`update public.clients set account_manager_id = ${w.users.adminB} where id = ${w.clientA1}`,
      '23503',
    );
  });

  it('no se puede usar un rol personalizado de otra organización', async () => {
    await expectSqlError(
      sql`update public.organization_members set role_id = ${w.customRoleB} where user_id = ${w.users.managerA} and organization_id = ${w.orgA}`,
      '42501',
    );
  });

  it('anon no puede leer ninguna tabla de negocio', async () => {
    for (const t of [
      'organizations',
      'clients',
      'client_locations',
      'organization_members',
      'profiles',
      'audit_logs',
    ]) {
      await expectSqlError(
        asUser(sql, null, (tx) => tx.unsafe(`select 1 from public.${t} limit 1`)),
        '42501',
      );
    }
  });

  it('un usuario sin organización no ve nada', async () => {
    await asUser(sql, w.users.outsider, async (tx) => {
      expect(await tx`select id from public.organizations`).toHaveLength(0);
      expect(await tx`select id from public.clients`).toHaveLength(0);
      expect(await tx`select id from public.client_locations`).toHaveLength(0);
    });
  });
});

describe('RLS · permisos dentro de una organización', () => {
  it('el gestor solo ve los clientes asignados', async () => {
    const rows = await asUser(
      sql,
      w.users.managerA,
      (tx) => tx<{ id: string }[]>`select id from public.clients`,
    );
    expect(ids(rows)).toEqual([w.clientA1]);
    const locs = await asUser(
      sql,
      w.users.managerA,
      (tx) => tx`select client_id from public.client_locations`,
    );
    expect(locs.map((l) => l.clientId)).toEqual([w.clientA1]);
  });

  it('el administrador ve todos los clientes de su organización', async () => {
    const rows = await asUser(
      sql,
      w.users.adminA,
      (tx) => tx<{ id: string }[]>`select id from public.clients`,
    );
    expect(ids(rows)).toEqual([w.clientA1, w.clientA2].sort());
  });

  it('el gestor puede editar su cliente pero no otros, ni crear clientes', async () => {
    const ok = await asUser(
      sql,
      w.users.managerA,
      (tx) =>
        tx`update public.clients set sector = 'Hostelería' where id = ${w.clientA1} returning id`,
    );
    expect(ok).toHaveLength(1);
    const no = await asUser(
      sql,
      w.users.managerA,
      (tx) => tx`update public.clients set sector = 'x' where id = ${w.clientA2} returning id`,
    );
    expect(no).toHaveLength(0);
    await expectSqlError(
      asUser(
        sql,
        w.users.managerA,
        (tx) => tx`insert into public.clients (organization_id, name) values (${w.orgA}, 'Nuevo')`,
      ),
      '42501',
    );
  });

  it('el gestor no puede escalar sus propios privilegios', async () => {
    const adminRole = (
      await sql<{ id: string }[]>`select id from public.roles where key = 'org_admin'`
    )[0]!.id;
    const r = await asUser(
      sql,
      w.users.managerA,
      (tx) => tx`
      update public.organization_members set role_id = ${adminRole}, all_clients_access = true
       where user_id = ${w.users.managerA} returning id`,
    );
    expect(r).toHaveLength(0);
    await expectSqlError(
      asUser(
        sql,
        w.users.managerA,
        (tx) =>
          tx`insert into public.client_members (organization_id, client_id, user_id) values (${w.orgA}, ${w.clientA2}, ${w.users.managerA})`,
      ),
      '42501',
    );
  });

  it('el permiso de aprobación por cliente solo aplica a ese cliente', async () => {
    const check = (userId: string, client: string) =>
      asUser(
        sql,
        userId,
        async (tx) =>
          (
            await tx<
              { v: boolean }[]
            >`select private.has_client_permission(${client}::uuid, 'responses.approve') as v`
          )[0]!.v,
      );
    expect(await check(w.users.approverA, w.clientA1)).toBe(true);
    expect(await check(w.users.approverA, w.clientA2)).toBe(false);
    expect(await check(w.users.managerA, w.clientA1)).toBe(false);
    expect(await check(w.users.adminA, w.clientA2)).toBe(true);
    expect(await check(w.users.adminB, w.clientA1)).toBe(false);
  });

  it('los roles personalizados no pueden recibir permisos de plataforma', async () => {
    const roleId = await asUser(sql, w.users.adminB, async (tx) => {
      const [r] = await tx<
        { id: string }[]
      >`insert into public.roles (organization_id, key, name) values (${w.orgB}, 'editor', 'Editor') returning id`;
      await tx`insert into public.role_permissions (role_id, permission_key) values (${r!.id}, 'clients.read')`;
      return r!.id;
    });
    await expectSqlError(
      asUser(
        sql,
        w.users.adminB,
        (tx) =>
          tx`insert into public.role_permissions (role_id, permission_key) values (${roleId}, 'platform.settings.manage')`,
      ),
      '42501',
    );
  });

  it('los roles de sistema no se pueden modificar desde una organización', async () => {
    const r = await asUser(
      sql,
      w.users.adminA,
      (tx) => tx`update public.roles set name = 'x' where key = 'org_admin' returning id`,
    );
    expect(r).toHaveLength(0);
    const adminRole = (
      await sql<{ id: string }[]>`select id from public.roles where key = 'org_admin'`
    )[0]!.id;
    await expectSqlError(
      asUser(
        sql,
        w.users.adminA,
        (tx) =>
          tx`insert into public.role_permissions (role_id, permission_key) values (${adminRole}, 'platform.settings.manage')`,
      ),
      '42501',
    );
  });

  it('no se puede eliminar ni degradar al último administrador', async () => {
    const managerRole = (
      await sql<{ id: string }[]>`select id from public.roles where key = 'account_manager'`
    )[0]!.id;
    await expectSqlError(
      asUser(
        sql,
        w.users.adminB,
        (tx) =>
          tx`update public.organization_members set role_id = ${managerRole} where user_id = ${w.users.adminB}`,
      ),
      '42501',
    );
    await expectSqlError(
      asUser(
        sql,
        w.users.adminB,
        (tx) => tx`delete from public.organization_members where user_id = ${w.users.adminB}`,
      ),
      '42501',
    );
  });

  it('un miembro suspendido pierde el acceso inmediatamente', async () => {
    await sql`update public.organization_members set status = 'suspended' where user_id = ${w.users.managerA}`;
    const rows = await asUser(sql, w.users.managerA, (tx) => tx`select id from public.clients`);
    expect(rows).toHaveLength(0);
    await sql`update public.organization_members set status = 'active' where user_id = ${w.users.managerA}`;
  });

  it('una organización suspendida bloquea el acceso de sus miembros', async () => {
    await sql`update public.organizations set status = 'suspended' where id = ${w.orgB}`;
    const rows = await asUser(sql, w.users.adminB, (tx) => tx`select id from public.clients`);
    expect(rows).toHaveLength(0);
    await sql`update public.organizations set status = 'active' where id = ${w.orgB}`;
  });

  it('el superadministrador ve todas las organizaciones', async () => {
    const rows = await asUser(
      sql,
      w.users.superadmin,
      (tx) =>
        tx<
          { id: string }[]
        >`select id from public.organizations where id in (${w.orgA}, ${w.orgB})`,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('Auditoría y datos inmutables', () => {
  it('registra cambios con el actor y no se puede alterar', async () => {
    await asUser(
      sql,
      w.users.adminA,
      (tx) => tx`update public.clients set phone = '+34 600 000 000' where id = ${w.clientA2}`,
    );
    const [log] = await sql`
      select actor_user_id, actor_type, action, changes from public.audit_logs
       where entity_id = ${w.clientA2} and action = 'clients.update' order by id desc limit 1`;
    expect(log!.actorUserId).toBe(w.users.adminA);
    expect(log!.actorType).toBe('user');
    expect(log!.changes).toMatchObject({ phone: { old: null, new: '+34 600 000 000' } });

    await expectSqlError(sql`update public.audit_logs set action = 'x'`, '42501');
    await expectSqlError(sql`delete from public.audit_logs`, '42501');
    await expectSqlError(
      asUser(
        sql,
        w.users.adminA,
        (tx) => tx`insert into public.audit_logs (action, entity_type) values ('fake', 'x')`,
      ),
      '42501',
    );
  });

  it('solo quien tiene audit.read consulta la auditoría', async () => {
    const admin = await asUser(
      sql,
      w.users.adminA,
      (tx) => tx`select id from public.audit_logs where organization_id = ${w.orgA}`,
    );
    expect(admin.length).toBeGreaterThan(0);
    const manager = await asUser(
      sql,
      w.users.managerA,
      (tx) => tx`select id from public.audit_logs`,
    );
    expect(manager).toHaveLength(0);
  });

  it('el log redacta claves sensibles', async () => {
    const [r] = await sql<
      { v: Record<string, unknown> }[]
    >`select private.redact('{"access_token":"abc","name":"x","client_secret":"s"}'::jsonb) as v`;
    expect(r!.v).toEqual({ access_token: '[REDACTED]', name: 'x', client_secret: '[REDACTED]' });
  });

  it('las versiones de personalidad de marca son inmutables', async () => {
    const v = await asUser(sql, w.users.adminA, async (tx) => {
      const [bp] = await tx<
        { id: string }[]
      >`insert into public.brand_profiles (organization_id, client_id) values (${w.orgA}, ${w.clientA1}) returning id`;
      const [ver] = await tx<{ id: string }[]>`
        insert into public.brand_profile_versions (organization_id, client_id, brand_profile_id, version, tone, created_by)
        values (${w.orgA}, ${w.clientA1}, ${bp!.id}, 1, 'Cercano', ${w.users.adminA}) returning id`;
      return ver!.id;
    });
    await expectSqlError(
      sql`update public.brand_profile_versions set tone = 'x' where id = ${v}`,
      '42501',
    );
    // El gestor (sin brand.write) no puede crear versiones.
    await expectSqlError(
      asUser(
        sql,
        w.users.managerA,
        (tx) =>
          tx`insert into public.brand_profiles (organization_id, client_id) values (${w.orgA}, ${w.clientA1})`,
      ),
      '42501',
    );
  });

  it('el interruptor global de publicación no es modificable por usuarios', async () => {
    await expectSqlError(
      asUser(
        sql,
        w.users.adminA,
        (tx) =>
          tx`update public.platform_settings set value = '{"enabled":true}' where key = 'publishing_kill_switch'`,
      ),
      '42501',
    );
  });
});

describe('Catálogo RBAC', () => {
  it('coincide con packages/shared/permissions.ts', async () => {
    const rows = await sql<
      { key: string; scope: string }[]
    >`select key, scope from public.permissions order by key`;
    const db = Object.fromEntries(rows.map((r) => [r.key, r.scope]));
    expect(db).toEqual({ ...PERMISSIONS });
  });

  it('todas las tablas públicas tienen RLS activada', async () => {
    const rows = await sql<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('las funciones SECURITY DEFINER fijan search_path', async () => {
    const rows = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`;
    expect(rows).toEqual([]);
  });
});
