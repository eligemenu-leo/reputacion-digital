-- =============================================================================
-- Migración 0003 · Fase 2: cuentas conectadas, sincronizaciones, bandeja,
-- borradores, aprobaciones, publicación e historial.
-- -----------------------------------------------------------------------------
-- Reglas de diseño:
--   * Lectura para usuarios mediante RLS. TODAS las mutaciones de flujo se hacen
--     desde la API/worker (service_role) tras comprobar permisos en código:
--     `authenticated` no tiene INSERT/UPDATE/DELETE en estas tablas, de modo que
--     nadie puede saltarse el flujo usando la API REST de Supabase con su JWT.
--   * La base de datos refuerza las invariantes críticas aunque el código falle:
--       - transiciones de estado válidas (trigger),
--       - no hay publicación sin aprobación vigente del texto exacto (trigger),
--       - como máximo una publicación activa o realizada por interacción (índice),
--       - borradores, aprobaciones, intentos, recibos e historial son append-only.
-- =============================================================================

create type public.connection_status as enum (
  'connected', 'pending_authorization', 'syncing', 'insufficient_access',
  'credentials_expired', 'temporary_error', 'disconnected');
create type public.interaction_kind as enum ('review', 'comment', 'reply', 'mention', 'web_mention');
create type public.interaction_state as enum (
  'new', 'analyzed', 'pending_response', 'draft_generated', 'pending_approval', 'approved',
  'publishing', 'published', 'publish_failed', 'discarded', 'closed_no_response');
create type public.sync_status as enum ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');
create type public.publication_status as enum ('queued', 'running', 'published', 'failed', 'cancelled');

-- Permite FK (client_id, location_id) que garantizan que la ubicación es del mismo cliente.
alter table public.client_locations add constraint client_locations_client_id_unique unique (client_id, id);

-- -----------------------------------------------------------------------------
-- Cuentas conectadas
-- -----------------------------------------------------------------------------
create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  location_id uuid,
  provider text not null check (provider in ('google_business_profile', 'facebook_page', 'instagram_business', 'web_search', 'rss', 'simulator')),
  external_account_id text not null check (char_length(external_account_id) between 1 and 300),
  display_name text not null check (char_length(display_name) between 1 and 200),
  status public.connection_status not null default 'pending_authorization',
  -- Datos ficticios: solo permitido con el proveedor simulador.
  is_simulated boolean not null default false,
  granted_scopes text[] not null default '{}',
  capabilities text[] not null default '{}',
  -- Configuración no secreta (p. ej. modos de fallo del simulador). Los tokens van en Vault (Fase 4).
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  authorized_at timestamptz,
  authorized_by uuid references auth.users (id) on delete set null,
  last_success_sync_at timestamptz,
  last_attempt_at timestamptz,
  next_run_at timestamptz,
  last_error_kind text,
  last_error_message text check (char_length(last_error_message) <= 1000),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connected_accounts_simulated check (is_simulated = (provider = 'simulator')),
  constraint connected_accounts_unique unique (client_id, provider, external_account_id),
  constraint connected_accounts_org_client_id unique (organization_id, client_id, id),
  constraint connected_accounts_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade,
  constraint connected_accounts_location_fk foreign key (client_id, location_id)
    references public.client_locations (client_id, id) on delete set null (location_id)
);
create index connected_accounts_org_idx on public.connected_accounts (organization_id, status);
create index connected_accounts_next_run_idx on public.connected_accounts (next_run_at) where status = 'connected';
create trigger connected_accounts_updated_at before update on public.connected_accounts
  for each row execute function private.set_updated_at();
create trigger connected_accounts_tenant_immutable before update on public.connected_accounts
  for each row execute function private.prevent_tenant_change();

-- -----------------------------------------------------------------------------
-- Ejecuciones de sincronización
-- -----------------------------------------------------------------------------
create table public.provider_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  connected_account_id uuid not null,
  trigger text not null check (trigger in ('schedule', 'manual', 'webhook', 'recovery')),
  requested_by uuid references auth.users (id) on delete set null,
  status public.sync_status not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  items_found integer not null default 0,
  items_created integer not null default 0,
  items_updated integer not null default 0,
  error_count integer not null default 0,
  failure_kind text,
  failure_reason text check (char_length(failure_reason) <= 1000),
  cancelled_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint provider_sync_runs_account_fk foreign key (organization_id, client_id, connected_account_id)
    references public.connected_accounts (organization_id, client_id, id) on delete cascade
);
create index provider_sync_runs_account_idx on public.provider_sync_runs (connected_account_id, created_at desc);
create index provider_sync_runs_org_idx on public.provider_sync_runs (organization_id, created_at desc);
-- Impide dos sincronizaciones simultáneas de la misma cuenta.
create unique index provider_sync_runs_one_active on public.provider_sync_runs (connected_account_id)
  where status in ('queued', 'running');

-- -----------------------------------------------------------------------------
-- Interacciones normalizadas
-- -----------------------------------------------------------------------------
create table public.external_interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  location_id uuid,
  connected_account_id uuid,
  provider text not null,
  kind public.interaction_kind not null,
  external_id text not null check (char_length(external_id) between 1 and 500),
  external_parent_id text,
  url text check (url is null or url ~* '^https?://'),
  author_display_name text check (char_length(author_display_name) <= 200),
  -- Identificador del autor seudonimizado (sha256 con pimienta). Nunca el id crudo.
  author_ref_hash text,
  content text check (char_length(content) <= 20000),
  language text,
  rating numeric(3, 1) check (rating >= 0),
  rating_scale smallint check (rating_scale > 0),
  content_hash text not null,
  original_created_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  state public.interaction_state not null default 'new',
  -- 1 baja · 2 normal · 3 alta · 4 crítica
  priority smallint not null default 2 check (priority between 1 and 4),
  assignee_id uuid,
  sentiment text check (sentiment in ('positive', 'negative', 'neutral', 'mixed')),
  category text,
  risk_flags text[] not null default '{}',
  -- Requiere revisión especializada antes de aprobar (reclamaciones graves, salud, legal…).
  requires_specialist boolean not null default false,
  existing_reply_content text,
  existing_reply_at timestamptz,
  approval_requested_by uuid references auth.users (id) on delete set null,
  approval_requested_at timestamptz,
  responded_at timestamptz,
  is_simulated boolean not null default false,
  search tsvector generated always as (
    to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(author_display_name, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint external_interactions_dedupe unique nulls not distinct (provider, connected_account_id, external_id),
  constraint external_interactions_org_client_id unique (organization_id, client_id, id),
  constraint external_interactions_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade,
  constraint external_interactions_location_fk foreign key (client_id, location_id)
    references public.client_locations (client_id, id) on delete set null (location_id),
  constraint external_interactions_account_fk foreign key (organization_id, client_id, connected_account_id)
    references public.connected_accounts (organization_id, client_id, id) on delete set null (connected_account_id),
  constraint external_interactions_assignee_fk foreign key (organization_id, assignee_id)
    references public.organization_members (organization_id, user_id) on delete set null (assignee_id)
);
create index external_interactions_inbox_idx on public.external_interactions (organization_id, state, original_created_at desc);
create index external_interactions_client_idx on public.external_interactions (client_id, original_created_at desc);
create index external_interactions_assignee_idx on public.external_interactions (assignee_id)
  where state not in ('published', 'discarded', 'closed_no_response');
create index external_interactions_search_idx on public.external_interactions using gin (search);
create trigger external_interactions_updated_at before update on public.external_interactions
  for each row execute function private.set_updated_at();
create trigger external_interactions_tenant_immutable before update on public.external_interactions
  for each row execute function private.prevent_tenant_change();

-- Transiciones válidas (espejo de packages/shared/src/interaction-state.ts; un test verifica que coinciden).
create table private.interaction_transitions (
  from_state public.interaction_state not null,
  to_state public.interaction_state not null,
  primary key (from_state, to_state)
);
insert into private.interaction_transitions (from_state, to_state) values
  ('new', 'analyzed'), ('new', 'pending_response'), ('new', 'draft_generated'), ('new', 'discarded'), ('new', 'closed_no_response'),
  ('analyzed', 'pending_response'), ('analyzed', 'draft_generated'), ('analyzed', 'discarded'), ('analyzed', 'closed_no_response'),
  ('pending_response', 'draft_generated'), ('pending_response', 'discarded'), ('pending_response', 'closed_no_response'),
  ('draft_generated', 'draft_generated'), ('draft_generated', 'pending_approval'), ('draft_generated', 'discarded'), ('draft_generated', 'closed_no_response'),
  ('pending_approval', 'approved'), ('pending_approval', 'draft_generated'), ('pending_approval', 'discarded'),
  ('approved', 'publishing'), ('approved', 'draft_generated'), ('approved', 'discarded'),
  ('publishing', 'published'), ('publishing', 'publish_failed'),
  ('publish_failed', 'publishing'), ('publish_failed', 'draft_generated'), ('publish_failed', 'discarded'),
  ('discarded', 'pending_response'), ('closed_no_response', 'pending_response');

create or replace function private.guard_interaction_state() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.state is distinct from old.state
     and not exists (select 1 from private.interaction_transitions t where t.from_state = old.state and t.to_state = new.state) then
    raise exception 'invalid interaction transition % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger external_interactions_state_guard before update of state on public.external_interactions
  for each row execute function private.guard_interaction_state();

-- Ediciones del contenido original por su autor.
create table public.interaction_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  interaction_id uuid not null,
  content text,
  rating numeric(3, 1),
  content_hash text not null,
  observed_at timestamptz not null default now(),
  constraint interaction_versions_fk foreign key (organization_id, client_id, interaction_id)
    references public.external_interactions (organization_id, client_id, id) on delete cascade
);
create index interaction_versions_interaction_idx on public.interaction_versions (interaction_id, observed_at desc);

-- -----------------------------------------------------------------------------
-- Borradores (cada edición = nueva versión inmutable)
-- -----------------------------------------------------------------------------
create table public.response_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  interaction_id uuid not null,
  version integer not null check (version > 0),
  content text not null check (char_length(content) between 1 and 5000),
  content_hash text not null,
  source text not null default 'human' check (source in ('human', 'ai')),
  ai_generation_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint response_drafts_version_unique unique (interaction_id, version),
  constraint response_drafts_org_client_id unique (organization_id, client_id, id),
  constraint response_drafts_interaction_fk foreign key (organization_id, client_id, interaction_id)
    references public.external_interactions (organization_id, client_id, id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Decisiones de aprobación (append-only; la aprobación se ata al hash exacto)
-- -----------------------------------------------------------------------------
create table public.response_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  interaction_id uuid not null,
  draft_id uuid not null,
  content_hash text not null,
  decision text not null check (decision in ('approved', 'rejected', 'returned')),
  note text check (char_length(note) <= 2000),
  specialist_reviewed boolean not null default false,
  decided_by uuid not null references auth.users (id) on delete restrict,
  decided_at timestamptz not null default now(),
  constraint response_approvals_org_client_id unique (organization_id, client_id, id),
  constraint response_approvals_draft_fk foreign key (organization_id, client_id, draft_id)
    references public.response_drafts (organization_id, client_id, id) on delete cascade,
  constraint response_approvals_interaction_fk foreign key (organization_id, client_id, interaction_id)
    references public.external_interactions (organization_id, client_id, id) on delete cascade
);
create index response_approvals_interaction_idx on public.response_approvals (interaction_id, decided_at desc);

-- -----------------------------------------------------------------------------
-- Publicación
-- -----------------------------------------------------------------------------
create table public.publication_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  interaction_id uuid not null,
  draft_id uuid not null,
  approval_id uuid not null,
  connected_account_id uuid not null,
  content text not null,
  content_hash text not null,
  idempotency_key text not null unique,
  status public.publication_status not null default 'queued',
  attempts integer not null default 0,
  last_error_kind text,
  last_error_message text check (char_length(last_error_message) <= 1000),
  external_reply_id text,
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint publication_jobs_org_client_id unique (organization_id, client_id, id),
  constraint publication_jobs_interaction_fk foreign key (organization_id, client_id, interaction_id)
    references public.external_interactions (organization_id, client_id, id) on delete cascade,
  constraint publication_jobs_draft_fk foreign key (organization_id, client_id, draft_id)
    references public.response_drafts (organization_id, client_id, id) on delete restrict,
  constraint publication_jobs_approval_fk foreign key (organization_id, client_id, approval_id)
    references public.response_approvals (organization_id, client_id, id) on delete restrict,
  constraint publication_jobs_account_fk foreign key (organization_id, client_id, connected_account_id)
    references public.connected_accounts (organization_id, client_id, id) on delete restrict
);
-- Nunca dos publicaciones vivas o completadas para la misma interacción.
create unique index publication_jobs_one_live on public.publication_jobs (interaction_id)
  where status in ('queued', 'running', 'published');
create index publication_jobs_status_idx on public.publication_jobs (status, updated_at);
create trigger publication_jobs_updated_at before update on public.publication_jobs
  for each row execute function private.set_updated_at();
create trigger publication_jobs_tenant_immutable before update on public.publication_jobs
  for each row execute function private.prevent_tenant_change();

-- Invariante: el trabajo debe corresponder a la ÚLTIMA decisión de la interacción,
-- que debe ser 'approved', sobre el ÚLTIMO borrador y con el MISMO texto.
create or replace function private.guard_publication_job() returns trigger
language plpgsql set search_path = '' as $$
declare
  last_approval record;
  last_draft record;
begin
  select a.id, a.decision, a.draft_id, a.content_hash into last_approval
    from public.response_approvals a where a.interaction_id = new.interaction_id
   order by a.decided_at desc, a.id desc limit 1;
  select d.id, d.content_hash into last_draft
    from public.response_drafts d where d.interaction_id = new.interaction_id
   order by d.version desc limit 1;
  if last_approval.id is distinct from new.approval_id or last_approval.decision <> 'approved' then
    raise exception 'publication requires the latest decision to be an approval' using errcode = '42501';
  end if;
  if last_draft.id is distinct from new.draft_id or last_approval.draft_id <> new.draft_id then
    raise exception 'publication requires the latest draft version' using errcode = '42501';
  end if;
  if new.content_hash <> last_approval.content_hash or new.content_hash <> last_draft.content_hash
     or encode(sha256(convert_to(new.content, 'UTF8')), 'hex') <> new.content_hash then
    raise exception 'publication content does not match the approved text' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger publication_jobs_guard before insert on public.publication_jobs
  for each row execute function private.guard_publication_job();

-- El texto y su aprobación no pueden cambiarse después de crear el trabajo.
create or replace function private.freeze_publication_job() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.content, new.content_hash, new.draft_id, new.approval_id, new.interaction_id, new.idempotency_key)
     is distinct from (old.content, old.content_hash, old.draft_id, old.approval_id, old.interaction_id, old.idempotency_key) then
    raise exception 'publication job content is immutable' using errcode = '42501';
  end if;
  if old.status = 'published' and new.status <> 'published' then
    raise exception 'a published job cannot change status' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger publication_jobs_freeze before update on public.publication_jobs
  for each row execute function private.freeze_publication_job();

create table public.publication_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  job_id uuid not null,
  attempt_no integer not null check (attempt_no > 0),
  -- 'publish' = llamada de publicación; 'status_check' = consulta del estado remoto antes de reintentar.
  operation text not null check (operation in ('publish', 'status_check')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('published', 'not_found', 'failed', 'ambiguous', 'blocked')),
  error_kind text,
  error_message text check (char_length(error_message) <= 1000),
  constraint publication_attempts_job_fk foreign key (organization_id, client_id, job_id)
    references public.publication_jobs (organization_id, client_id, id) on delete cascade
);
create index publication_attempts_job_idx on public.publication_attempts (job_id, started_at);

create table public.publication_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  job_id uuid not null unique,
  external_reply_id text,
  published_content_hash text not null,
  provider_state text,
  verified_at timestamptz not null default now(),
  constraint publication_receipts_job_fk foreign key (organization_id, client_id, job_id)
    references public.publication_jobs (organization_id, client_id, id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Historial de cada interacción (append-only)
-- -----------------------------------------------------------------------------
create table public.interaction_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  client_id uuid not null,
  interaction_id uuid not null,
  event_type text not null check (char_length(event_type) <= 60),
  from_state public.interaction_state,
  to_state public.interaction_state,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_type text not null default 'user' check (actor_type in ('user', 'system')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint interaction_events_fk foreign key (organization_id, client_id, interaction_id)
    references public.external_interactions (organization_id, client_id, id) on delete cascade
);
create index interaction_events_interaction_idx on public.interaction_events (interaction_id, id);

-- -----------------------------------------------------------------------------
-- Estado remoto del simulador (solo desarrollo/pruebas; inaccesible para usuarios)
-- -----------------------------------------------------------------------------
create table private.simulator_remote (
  connected_account_id uuid not null,
  interaction_external_id text not null,
  reply_id text not null,
  reply_content text not null,
  published_at timestamptz not null default now(),
  primary key (connected_account_id, interaction_external_id)
);
-- «Inventario» remoto simulado: reseñas que el simulador expone al sincronizar.
create table private.simulator_items (
  connected_account_id uuid not null,
  external_id text not null,
  author_name text not null,
  author_id text not null,
  content text,
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (connected_account_id, external_id)
);
create index simulator_items_updated_idx on private.simulator_items (connected_account_id, updated_at);

-- Append-only
create trigger interaction_versions_append_only before update or delete on public.interaction_versions
  for each row execute function private.forbid_mutation();
create trigger response_drafts_append_only before update on public.response_drafts
  for each row execute function private.forbid_mutation();
create trigger response_approvals_append_only before update or delete on public.response_approvals
  for each row execute function private.forbid_mutation();
create trigger publication_attempts_append_only before delete on public.publication_attempts
  for each row execute function private.forbid_mutation();
create trigger publication_receipts_append_only before update or delete on public.publication_receipts
  for each row execute function private.forbid_mutation();
create trigger interaction_events_append_only before update or delete on public.interaction_events
  for each row execute function private.forbid_mutation();

-- Auditoría de configuración (las acciones de flujo quedan en interaction_events + audit_logs explícitos).
create trigger connected_accounts_audit after insert or update or delete on public.connected_accounts
  for each row execute function private.audit_row_change();

-- -----------------------------------------------------------------------------
-- Privilegios: authenticated solo lee. service_role (API/worker) escribe.
-- -----------------------------------------------------------------------------
revoke all on public.connected_accounts, public.provider_sync_runs, public.external_interactions,
  public.interaction_versions, public.response_drafts, public.response_approvals, public.publication_jobs,
  public.publication_attempts, public.publication_receipts, public.interaction_events
  from anon, authenticated;
grant select on public.connected_accounts, public.provider_sync_runs, public.external_interactions,
  public.interaction_versions, public.response_drafts, public.response_approvals, public.publication_jobs,
  public.publication_attempts, public.publication_receipts, public.interaction_events
  to authenticated;
-- La configuración interna de conexiones no se expone (puede contener detalles operativos).
revoke select on public.connected_accounts from authenticated;
grant select (id, organization_id, client_id, location_id, provider, external_account_id, display_name, status,
  is_simulated, granted_scopes, capabilities, authorized_at, last_success_sync_at, last_attempt_at, next_run_at,
  last_error_kind, last_error_message, disconnected_at, created_at, updated_at)
  on public.connected_accounts to authenticated;

revoke all on private.interaction_transitions, private.simulator_remote, private.simulator_items from public;
grant select on private.interaction_transitions to service_role;
grant all on private.simulator_remote, private.simulator_items to service_role;
grant all on public.connected_accounts, public.provider_sync_runs, public.external_interactions,
  public.interaction_versions, public.response_drafts, public.response_approvals, public.publication_jobs,
  public.publication_attempts, public.publication_receipts, public.interaction_events to service_role;
grant usage, select on all sequences in schema public to service_role;

-- -----------------------------------------------------------------------------
-- RLS (lectura)
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'connected_accounts', 'provider_sync_runs', 'external_interactions', 'interaction_versions',
    'response_drafts', 'response_approvals', 'publication_jobs', 'publication_attempts',
    'publication_receipts', 'interaction_events'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create policy connected_accounts_select on public.connected_accounts for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'connections.read'));
create policy provider_sync_runs_select on public.provider_sync_runs for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'connections.read'));

do $$
declare t text;
begin
  foreach t in array array[
    'external_interactions', 'interaction_versions', 'response_drafts', 'response_approvals',
    'publication_jobs', 'publication_attempts', 'publication_receipts', 'interaction_events'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.has_client_permission_in(organization_id, client_id, %L))',
      t || '_select', t, 'interactions.read');
  end loop;
end $$;
