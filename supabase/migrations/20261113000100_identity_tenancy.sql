-- =============================================================================
-- Migración 0001 · Identity & Access + Organizations & Clients
-- -----------------------------------------------------------------------------
-- Crea la base multi-tenant: perfiles, superadministradores, organizaciones,
-- catálogo RBAC (permisos, roles, role_permissions), membresías, clientes,
-- ubicaciones, asignaciones por cliente, personalidad de marca versionada,
-- ajustes de plataforma (interruptor de publicación) y auditoría.
--
-- Principios:
--   * UUID internos, fechas timestamptz (UTC).
--   * Toda tabla de tenant lleva organization_id y claves compuestas
--     (organization_id, id) para que las FK no puedan cruzar organizaciones.
--   * RLS activada y forzada en todas las tablas expuestas.
--   * Las funciones de autorización viven en el esquema `private`, que NO se
--     expone por la API REST de Supabase.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.organization_status as enum ('active', 'suspended', 'archived');
create type public.member_status as enum ('invited', 'active', 'suspended');
create type public.client_status as enum ('onboarding', 'active', 'paused', 'archived');
create type public.permission_scope as enum ('platform', 'organization', 'client');
create type public.address_form as enum ('tu', 'usted', 'auto');
create type public.emoji_policy as enum ('none', 'moderate', 'free');
create type public.response_length as enum ('short', 'medium', 'long');

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------
create or replace function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Impide mover una fila a otro tenant/cliente después de crearla.
create or replace function private.prevent_tenant_change() returns trigger
language plpgsql set search_path = '' as $$
declare
  old_j jsonb := to_jsonb(old);
  new_j jsonb := to_jsonb(new);
begin
  if old_j ? 'organization_id' and (old_j->'organization_id') is distinct from (new_j->'organization_id') then
    raise exception 'organization_id is immutable' using errcode = '42501';
  end if;
  if old_j ? 'client_id' and (old_j->'client_id') is distinct from (new_j->'client_id') then
    raise exception 'client_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Perfiles (1:1 con auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text check (char_length(full_name) <= 200),
  avatar_url text check (char_length(avatar_url) <= 2000),
  locale text not null default 'es' check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone text not null default 'Europe/Madrid' check (char_length(timezone) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- -----------------------------------------------------------------------------
-- Superadministradores de plataforma (fuera del modelo de organización)
-- -----------------------------------------------------------------------------
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Organizaciones
-- -----------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  status public.organization_status not null default 'active',
  default_locale text not null default 'es',
  default_timezone text not null default 'Europe/Madrid',
  -- Interruptor por organización: suspende publicaciones externas.
  publishing_paused boolean not null default false,
  require_admin_mfa boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- RBAC
-- -----------------------------------------------------------------------------
create table public.permissions (
  key text primary key check (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  scope public.permission_scope not null,
  description text not null
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  -- NULL = rol de sistema (común a todas las organizaciones, no editable)
  organization_id uuid references public.organizations (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null check (char_length(name) between 2 and 120),
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roles_system_has_no_org check ((is_system and organization_id is null) or (not is_system and organization_id is not null)),
  constraint roles_org_key_unique unique nulls not distinct (organization_id, key)
);
create trigger roles_updated_at before update on public.roles
  for each row execute function private.set_updated_at();
create trigger roles_tenant_immutable before update on public.roles
  for each row execute function private.prevent_tenant_change();

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);
create index role_permissions_permission_idx on public.role_permissions (permission_key);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete restrict,
  -- true: el rol aplica a todos los clientes de la organización.
  -- false: solo a los clientes asignados en client_members.
  all_clients_access boolean not null default false,
  status public.member_status not null default 'active',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_unique unique (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id) where status = 'active';
create index organization_members_role_idx on public.organization_members (role_id);
create trigger organization_members_updated_at before update on public.organization_members
  for each row execute function private.set_updated_at();
create trigger organization_members_tenant_immutable before update on public.organization_members
  for each row execute function private.prevent_tenant_change();

-- -----------------------------------------------------------------------------
-- Clientes y ubicaciones
-- -----------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  legal_name text check (char_length(legal_name) <= 200),
  sector text check (char_length(sector) <= 120),
  description text check (char_length(description) <= 4000),
  logo_path text check (char_length(logo_path) <= 500),
  website text check (website is null or website ~* '^https?://[^\s]+$'),
  phone text check (char_length(phone) <= 40),
  primary_language text not null default 'es' check (primary_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone text not null default 'Europe/Madrid' check (char_length(timezone) <= 64),
  account_manager_id uuid,
  status public.client_status not null default 'onboarding',
  onboarded_at date not null default current_date,
  -- Contexto de negocio que la IA puede usar (información verificada por la agencia).
  business_context text check (char_length(business_context) <= 8000),
  ai_enabled boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint clients_org_id_unique unique (organization_id, id),
  -- El responsable debe ser miembro de la MISMA organización.
  constraint clients_account_manager_fk foreign key (organization_id, account_manager_id)
    references public.organization_members (organization_id, user_id) on delete set null (account_manager_id)
);
create index clients_org_status_idx on public.clients (organization_id, status);
create index clients_org_name_idx on public.clients (organization_id, lower(name));
create index clients_account_manager_idx on public.clients (account_manager_id) where account_manager_id is not null;
create trigger clients_updated_at before update on public.clients
  for each row execute function private.set_updated_at();
create trigger clients_tenant_immutable before update on public.clients
  for each row execute function private.prevent_tenant_change();

create table public.client_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  address_line text check (char_length(address_line) <= 300),
  city text check (char_length(city) <= 120),
  region text check (char_length(region) <= 120),
  postal_code text check (char_length(postal_code) <= 20),
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  latitude numeric(9, 6) check (latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude between -180 and 180),
  phone text check (char_length(phone) <= 40),
  timezone text check (char_length(timezone) <= 64),
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_locations_org_id_unique unique (organization_id, id),
  constraint client_locations_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade
);
create index client_locations_client_idx on public.client_locations (client_id);
create unique index client_locations_one_primary on public.client_locations (client_id) where is_primary;
create trigger client_locations_updated_at before update on public.client_locations
  for each row execute function private.set_updated_at();
create trigger client_locations_tenant_immutable before update on public.client_locations
  for each row execute function private.prevent_tenant_change();

-- Asignación de usuarios a clientes concretos (+ rol adicional opcional por cliente,
-- p.ej. "approver" para un único cliente).
create table public.client_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  user_id uuid not null,
  role_id uuid references public.roles (id) on delete restrict,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint client_members_unique unique (client_id, user_id),
  constraint client_members_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade,
  -- Solo se puede asignar a miembros de la misma organización.
  constraint client_members_member_fk foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id) on delete cascade
);
create index client_members_user_idx on public.client_members (user_id);
create trigger client_members_tenant_immutable before update on public.client_members
  for each row execute function private.prevent_tenant_change();

-- Un rol personalizado solo puede usarse dentro de su organización.
create or replace function private.check_role_belongs_to_org() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r_org uuid;
  r_system boolean;
begin
  if new.role_id is null then
    return new;
  end if;
  select organization_id, is_system into r_org, r_system from public.roles where id = new.role_id;
  if not found then
    raise exception 'role not found' using errcode = '23503';
  end if;
  if not r_system and r_org is distinct from new.organization_id then
    raise exception 'role belongs to another organization' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger organization_members_role_check before insert or update of role_id on public.organization_members
  for each row execute function private.check_role_belongs_to_org();
create trigger client_members_role_check before insert or update of role_id on public.client_members
  for each row execute function private.check_role_belongs_to_org();

-- -----------------------------------------------------------------------------
-- Personalidad de marca (versionada, versiones inmutables)
-- -----------------------------------------------------------------------------
create table public.brand_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brand_profiles_client_unique unique (client_id),
  constraint brand_profiles_org_id_unique unique (organization_id, id),
  constraint brand_profiles_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade
);
create trigger brand_profiles_updated_at before update on public.brand_profiles
  for each row execute function private.set_updated_at();
create trigger brand_profiles_tenant_immutable before update on public.brand_profiles
  for each row execute function private.prevent_tenant_change();

create table public.brand_profile_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  brand_profile_id uuid not null,
  version integer not null check (version > 0),
  tone text check (char_length(tone) <= 300),
  formality smallint check (formality between 1 and 5),
  address_form public.address_form not null default 'auto',
  response_language text check (response_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  recommended_expressions text[] not null default '{}',
  forbidden_expressions text[] not null default '{}',
  emoji_policy public.emoji_policy not null default 'none',
  preferred_length public.response_length not null default 'medium',
  approved_examples jsonb not null default '[]'::jsonb check (jsonb_typeof(approved_examples) = 'array'),
  extra_instructions text check (char_length(extra_instructions) <= 4000),
  verified_business_info jsonb not null default '{}'::jsonb check (jsonb_typeof(verified_business_info) = 'object'),
  change_note text check (char_length(change_note) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint brand_profile_versions_unique unique (brand_profile_id, version),
  constraint brand_profile_versions_org_id_unique unique (organization_id, id),
  constraint brand_profile_versions_profile_fk foreign key (organization_id, brand_profile_id)
    references public.brand_profiles (organization_id, id) on delete cascade,
  constraint brand_profile_versions_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade
);
alter table public.brand_profiles
  add constraint brand_profiles_current_version_fk foreign key (organization_id, current_version_id)
  references public.brand_profile_versions (organization_id, id) on delete set null (current_version_id);

-- -----------------------------------------------------------------------------
-- Ajustes de plataforma (incluye interruptor global de publicación)
-- -----------------------------------------------------------------------------
create table public.platform_settings (
  key text primary key check (key ~ '^[a-z_]+$'),
  value jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger platform_settings_updated_at before update on public.platform_settings
  for each row execute function private.set_updated_at();
insert into public.platform_settings (key, value) values
  ('publishing_kill_switch', '{"enabled": false, "reason": null}'::jsonb);

-- -----------------------------------------------------------------------------
-- Auditoría (append-only)
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete set null,
  client_id uuid,
  actor_user_id uuid,
  actor_type text not null default 'user' check (actor_type in ('user', 'system', 'service')),
  action text not null check (char_length(action) <= 120),
  entity_type text not null check (char_length(entity_type) <= 80),
  entity_id text,
  changes jsonb,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  ip_address inet,
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

create or replace function private.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function private.forbid_mutation();
create trigger brand_profile_versions_append_only before update on public.brand_profile_versions
  for each row execute function private.forbid_mutation();

-- Columnas que jamás se copian al log.
create or replace function private.redact(j jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(
    (select jsonb_object_agg(k, case when k ~* '(token|secret|password|credential|api_key)' then '"[REDACTED]"'::jsonb else v end)
     from jsonb_each(j) as e(k, v)),
    '{}'::jsonb)
$$;

create or replace function private.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_j jsonb := case when tg_op in ('UPDATE', 'DELETE') then private.redact(to_jsonb(old)) end;
  new_j jsonb := case when tg_op in ('INSERT', 'UPDATE') then private.redact(to_jsonb(new)) end;
  row_j jsonb := coalesce(new_j, old_j);
  diff jsonb;
  org uuid;
  actor uuid := auth.uid();
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('old', old_j -> k, 'new', new_j -> k))
      into diff
      from jsonb_object_keys(new_j) as k
     where (old_j -> k) is distinct from (new_j -> k) and k <> 'updated_at';
    if diff is null then
      return new;
    end if;
  elsif tg_op = 'INSERT' then
    diff := jsonb_build_object('new', new_j);
  else
    diff := jsonb_build_object('old', old_j);
  end if;

  org := case
    when tg_table_name = 'organizations' then (row_j ->> 'id')::uuid
    when row_j ? 'organization_id' then (row_j ->> 'organization_id')::uuid
    when tg_table_name = 'role_permissions' then (select r.organization_id from public.roles r where r.id = (row_j ->> 'role_id')::uuid)
  end;

  insert into public.audit_logs (organization_id, client_id, actor_user_id, actor_type, action, entity_type, entity_id, changes)
  values (
    org,
    case when tg_table_name = 'clients' then (row_j ->> 'id')::uuid else (row_j ->> 'client_id')::uuid end,
    actor,
    case when actor is null then 'system' else 'user' end,
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(row_j ->> 'id', row_j ->> 'user_id', row_j ->> 'key', concat_ws(':', row_j ->> 'role_id', row_j ->> 'permission_key')),
    diff
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'organizations', 'organization_members', 'roles', 'role_permissions', 'clients',
    'client_locations', 'client_members', 'brand_profile_versions', 'brand_profiles',
    'platform_admins', 'platform_settings'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row_change()',
      t || '_audit', t);
  end loop;
end $$;

-- =============================================================================
-- Funciones de autorización (SECURITY DEFINER, sin search_path mutable)
-- =============================================================================
create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())
$$;

create or replace function private.is_org_member(org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
      join public.organizations o on o.id = m.organization_id
     where m.organization_id = org and m.user_id = auth.uid()
       and m.status = 'active' and o.status = 'active')
$$;

create or replace function private.has_org_permission(org uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() or exists (
    select 1
      from public.organization_members m
      join public.organizations o on o.id = m.organization_id and o.status = 'active'
      join public.role_permissions rp on rp.role_id = m.role_id
     where m.organization_id = org and m.user_id = auth.uid() and m.status = 'active'
       and rp.permission_key = perm)
$$;

-- Permiso efectivo sobre un cliente:
--   rol de organización (si all_clients_access o asignado al cliente)
--   ∪ rol adicional de la asignación client_members.
-- Recibe la organización explícitamente para no tener que leer la fila del
-- cliente (necesario en INSERT ... RETURNING, donde la fila aún no es visible).
create or replace function private.has_client_permission_in(org uuid, client uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() or exists (
    select 1
      from public.organization_members m
      join public.organizations o on o.id = m.organization_id and o.status = 'active'
      left join public.client_members cm on cm.client_id = client and cm.user_id = m.user_id and cm.organization_id = org
     where m.organization_id = org and m.user_id = auth.uid() and m.status = 'active'
       and (
         ((m.all_clients_access or cm.id is not null)
            and exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = perm))
         or (cm.role_id is not null
            and exists (select 1 from public.role_permissions rp where rp.role_id = cm.role_id and rp.permission_key = perm))
       ))
$$;

create or replace function private.has_client_permission(client uuid, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select private.has_client_permission_in(c.organization_id, c.id, perm) from public.clients c where c.id = client),
    false)
$$;

create or replace function private.shares_org_with(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members a
      join public.organization_members b on b.organization_id = a.organization_id
     where a.user_id = auth.uid() and a.status = 'active' and b.user_id = other)
$$;

revoke all on all functions in schema private from public;
grant execute on function
  private.is_platform_admin(), private.is_org_member(uuid), private.has_org_permission(uuid, text),
  private.has_client_permission(uuid, text), private.has_client_permission_in(uuid, uuid, text),
  private.shares_org_with(uuid)
  to authenticated, service_role;

-- Impide eliminar o degradar al último administrador activo de una organización.
create or replace function private.protect_last_org_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  admin_role uuid := (select id from public.roles where key = 'org_admin' and is_system);
  remaining int;
begin
  if old.role_id <> admin_role or old.status <> 'active' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role_id = admin_role and new.status = 'active' then
    return new;
  end if;
  -- Si la organización entera se está borrando (cascade), no bloquear.
  if not exists (select 1 from public.organizations where id = old.organization_id) then
    return coalesce(new, old);
  end if;
  select count(*) into remaining from public.organization_members
   where organization_id = old.organization_id and role_id = admin_role and status = 'active' and id <> old.id;
  if remaining = 0 then
    raise exception 'an organization must keep at least one active org_admin' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger organization_members_last_admin before update or delete on public.organization_members
  for each row execute function private.protect_last_org_admin();

-- =============================================================================
-- Privilegios: mínimo necesario. anon no accede a nada de negocio.
-- =============================================================================
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

revoke all on public.profiles, public.platform_admins, public.organizations, public.permissions,
  public.roles, public.role_permissions, public.organization_members, public.clients,
  public.client_locations, public.client_members, public.brand_profiles,
  public.brand_profile_versions, public.platform_settings, public.audit_logs
  from authenticated;

grant select, update (full_name, avatar_url, locale, timezone) on public.profiles to authenticated;
grant select on public.platform_admins to authenticated;
grant select, update (name, default_locale, default_timezone, publishing_paused, require_admin_mfa) on public.organizations to authenticated;
grant select on public.permissions to authenticated;
grant select, insert, update, delete on public.roles to authenticated;
grant select, insert, delete on public.role_permissions to authenticated;
grant select, insert, update (role_id, all_clients_access, status), delete on public.organization_members to authenticated;
grant select, insert, update (name, legal_name, sector, description, logo_path, website, phone, primary_language,
  timezone, account_manager_id, status, onboarded_at, business_context, ai_enabled, archived_at) on public.clients to authenticated;
grant select, insert, update, delete on public.client_locations to authenticated;
grant select, insert, update (role_id), delete on public.client_members to authenticated;
grant select, insert, update (current_version_id) on public.brand_profiles to authenticated;
grant select, insert on public.brand_profile_versions to authenticated;
grant select on public.platform_settings to authenticated;
grant select on public.audit_logs to authenticated;

-- =============================================================================
-- Row Level Security
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'platform_admins', 'organizations', 'permissions', 'roles', 'role_permissions',
    'organization_members', 'clients', 'client_locations', 'client_members', 'brand_profiles',
    'brand_profile_versions', 'platform_settings', 'audit_logs'
  ] loop
    -- No se usa FORCE: las funciones SECURITY DEFINER (propiedad del rol
    -- propietario de las migraciones) deben poder leer las tablas de membresía
    -- sin recursión de políticas. Los roles de la API (anon/authenticated)
    -- nunca son propietarios de las tablas.
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_org_with(id) or (select private.is_platform_admin()));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- platform_admins
create policy platform_admins_select on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_platform_admin()));

-- organizations
create policy organizations_select on public.organizations for select to authenticated
  using (private.is_org_member(id) or (select private.is_platform_admin()));
create policy organizations_update on public.organizations for update to authenticated
  using (private.has_org_permission(id, 'organization.manage'))
  with check (private.has_org_permission(id, 'organization.manage'));

-- permissions (catálogo público para usuarios autenticados)
create policy permissions_select on public.permissions for select to authenticated using (true);

-- roles
create policy roles_select on public.roles for select to authenticated
  using (is_system or private.is_org_member(organization_id) or (select private.is_platform_admin()));
create policy roles_insert on public.roles for insert to authenticated
  with check (not is_system and organization_id is not null and private.has_org_permission(organization_id, 'roles.manage'));
create policy roles_update on public.roles for update to authenticated
  using (not is_system and private.has_org_permission(organization_id, 'roles.manage'))
  with check (not is_system and private.has_org_permission(organization_id, 'roles.manage'));
create policy roles_delete on public.roles for delete to authenticated
  using (not is_system and private.has_org_permission(organization_id, 'roles.manage'));

-- role_permissions: solo roles personalizados y nunca permisos de plataforma
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id));
create policy role_permissions_insert on public.role_permissions for insert to authenticated
  with check (
    exists (select 1 from public.roles r where r.id = role_id and not r.is_system
              and private.has_org_permission(r.organization_id, 'roles.manage'))
    and exists (select 1 from public.permissions p where p.key = permission_key and p.scope <> 'platform'));
create policy role_permissions_delete on public.role_permissions for delete to authenticated
  using (exists (select 1 from public.roles r where r.id = role_id and not r.is_system
                   and private.has_org_permission(r.organization_id, 'roles.manage')));

-- organization_members
create policy org_members_select on public.organization_members for select to authenticated
  using (private.is_org_member(organization_id) or (select private.is_platform_admin()));
create policy org_members_insert on public.organization_members for insert to authenticated
  with check (private.has_org_permission(organization_id, 'members.manage'));
create policy org_members_update on public.organization_members for update to authenticated
  using (private.has_org_permission(organization_id, 'members.manage'))
  with check (private.has_org_permission(organization_id, 'members.manage'));
create policy org_members_delete on public.organization_members for delete to authenticated
  using (private.has_org_permission(organization_id, 'members.manage'));

-- clients
create policy clients_select on public.clients for select to authenticated
  using (private.has_client_permission_in(organization_id, id, 'clients.read'));
create policy clients_insert on public.clients for insert to authenticated
  with check (private.has_org_permission(organization_id, 'clients.create'));
create policy clients_update on public.clients for update to authenticated
  using (private.has_client_permission_in(organization_id, id, 'clients.update'))
  with check (private.has_client_permission_in(organization_id, id, 'clients.update'));

-- client_locations
create policy client_locations_select on public.client_locations for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'clients.read'));
create policy client_locations_insert on public.client_locations for insert to authenticated
  with check (private.has_client_permission_in(organization_id, client_id, 'clients.update'));
create policy client_locations_update on public.client_locations for update to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'clients.update'))
  with check (private.has_client_permission_in(organization_id, client_id, 'clients.update'));
create policy client_locations_delete on public.client_locations for delete to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'clients.update'));

-- client_members
create policy client_members_select on public.client_members for select to authenticated
  using (user_id = (select auth.uid()) or private.has_client_permission_in(organization_id, client_id, 'clients.read'));
create policy client_members_insert on public.client_members for insert to authenticated
  with check (private.has_org_permission(organization_id, 'members.manage'));
create policy client_members_update on public.client_members for update to authenticated
  using (private.has_org_permission(organization_id, 'members.manage'))
  with check (private.has_org_permission(organization_id, 'members.manage'));
create policy client_members_delete on public.client_members for delete to authenticated
  using (private.has_org_permission(organization_id, 'members.manage'));

-- brand_profiles / versions
create policy brand_profiles_select on public.brand_profiles for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'clients.read'));
create policy brand_profiles_insert on public.brand_profiles for insert to authenticated
  with check (private.has_client_permission_in(organization_id, client_id, 'brand.write'));
create policy brand_profiles_update on public.brand_profiles for update to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'brand.write'))
  with check (private.has_client_permission_in(organization_id, client_id, 'brand.write'));
create policy brand_profile_versions_select on public.brand_profile_versions for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'clients.read'));
create policy brand_profile_versions_insert on public.brand_profile_versions for insert to authenticated
  with check (private.has_client_permission_in(organization_id, client_id, 'brand.write') and created_by = (select auth.uid()));

-- platform_settings
create policy platform_settings_select on public.platform_settings for select to authenticated using (true);

-- audit_logs
create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((select private.is_platform_admin())
         or (organization_id is not null and private.has_org_permission(organization_id, 'audit.read')));
