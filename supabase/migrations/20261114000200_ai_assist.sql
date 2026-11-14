-- =============================================================================
-- Migración 0004 · Fase 3: asistencia por IA (clasificación y borradores)
--
-- * ai_generations: registro inmutable de cada llamada al modelo (o intento
--   bloqueado): modelo, versión de prompt, versión de marca, hash de entrada,
--   salida validada, tokens, coste y latencia. Las filas nacen 'running' con
--   el coste ESTIMADO reservado (para que dos llamadas simultáneas no superen
--   el presupuesto) y solo pueden pasar una vez a un estado final.
-- * ai_budgets: presupuesto mensual por organización (USD, como factura el
--   proveedor) con corte automático.
-- * external_interactions: resultado de la clasificación y estado del análisis
--   (fuente de verdad del «outbox» de clasificación: ai_status = 'pending').
-- * platform_settings.ai_real_data_allowed: hasta firmar el DPA con el
--   proveedor, la IA SOLO procesa interacciones simuladas.
-- =============================================================================

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null,
  interaction_id uuid,
  kind text not null check (kind in ('classification', 'draft')),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'rejected', 'blocked')),
  provider text not null check (provider in ('openai', 'fake')),
  model text not null check (char_length(model) <= 100),
  prompt_version text not null check (char_length(prompt_version) <= 60),
  brand_profile_version_id uuid,
  variant text check (variant in ('initial', 'another', 'shorter', 'warmer', 'more_formal')),
  input_hash text not null,
  output jsonb,
  -- Avisos de validación (p. ej. borrador rechazado por contener una URL).
  warnings text[] not null default '{}',
  error_kind text check (char_length(error_kind) <= 60),
  error_message text check (char_length(error_message) <= 1000),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  estimated_cost_usd numeric(12, 6) not null default 0 check (estimated_cost_usd >= 0),
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  latency_ms integer check (latency_ms >= 0),
  attempts smallint not null default 1 check (attempts between 1 and 5),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_generations_org_client_id unique (organization_id, client_id, id),
  constraint ai_generations_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade,
  constraint ai_generations_interaction_fk foreign key (organization_id, client_id, interaction_id)
    references public.external_interactions (organization_id, client_id, id) on delete cascade,
  constraint ai_generations_brand_fk foreign key (organization_id, brand_profile_version_id)
    references public.brand_profile_versions (organization_id, id) on delete restrict
);
create index ai_generations_org_month_idx on public.ai_generations (organization_id, created_at desc);
create index ai_generations_interaction_idx on public.ai_generations (interaction_id, created_at desc);
create index ai_generations_cache_idx on public.ai_generations (interaction_id, kind, input_hash)
  where status = 'succeeded';

-- Una generación solo puede cerrarse una vez; después es inmutable.
create or replace function private.guard_ai_generation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'running' then
    raise exception 'ai_generations rows are immutable once completed' using errcode = '42501';
  end if;
  if new.organization_id <> old.organization_id or new.client_id <> old.client_id
     or new.interaction_id is distinct from old.interaction_id or new.kind <> old.kind
     or new.model <> old.model or new.prompt_version <> old.prompt_version
     or new.input_hash <> old.input_hash or new.created_at <> old.created_at
     or new.brand_profile_version_id is distinct from old.brand_profile_version_id then
    raise exception 'ai_generations identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ai_generations_guard before update on public.ai_generations
  for each row execute function private.guard_ai_generation();

-- Un borrador de IA apunta a su generación.
alter table public.response_drafts
  add constraint response_drafts_ai_generation_fk foreign key (organization_id, client_id, ai_generation_id)
  references public.ai_generations (organization_id, client_id, id) on delete restrict;
alter table public.response_drafts
  add constraint response_drafts_ai_source check ((source = 'ai') = (ai_generation_id is not null));

-- Presupuesto mensual por organización.
create table public.ai_budgets (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  monthly_limit_usd numeric(10, 2) not null default 10 check (monthly_limit_usd >= 0 and monthly_limit_usd <= 100000),
  hard_stop boolean not null default true,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger ai_budgets_updated_at before update on public.ai_budgets
  for each row execute function private.set_updated_at();

-- Resultado de la clasificación en la interacción.
create type public.ai_analysis_status as enum ('not_requested', 'pending', 'running', 'done', 'failed', 'skipped');
alter table public.external_interactions
  add column ai_status public.ai_analysis_status not null default 'not_requested',
  add column ai_attempts smallint not null default 0 check (ai_attempts >= 0),
  add column ai_error text check (char_length(ai_error) <= 500),
  add column ai_classification_id uuid,
  add column topics text[] not null default '{}',
  add column ai_confidence numeric(3, 2) check (ai_confidence between 0 and 1),
  add column requires_response boolean,
  add constraint external_interactions_ai_classification_fk foreign key (organization_id, client_id, ai_classification_id)
    references public.ai_generations (organization_id, client_id, id) on delete set null (ai_classification_id);
create index external_interactions_ai_pending_idx on public.external_interactions (updated_at)
  where ai_status in ('pending', 'running');

-- Hasta firmar el DPA, la IA solo trabaja con datos simulados.
insert into public.platform_settings (key, value) values
  ('ai_real_data_allowed', '{"enabled": false, "reason": "DPA con el proveedor de IA pendiente de firma"}'::jsonb)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Privilegios y RLS: authenticated solo lee; API/worker (service_role) escribe.
-- -----------------------------------------------------------------------------
revoke all on public.ai_generations, public.ai_budgets from anon, authenticated;
grant select on public.ai_generations, public.ai_budgets to authenticated;
grant all on public.ai_generations, public.ai_budgets to service_role;

alter table public.ai_generations enable row level security;
alter table public.ai_budgets enable row level security;

create policy ai_generations_select on public.ai_generations for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'interactions.read'));
create policy ai_budgets_select on public.ai_budgets for select to authenticated
  using (private.has_org_permission(organization_id, 'organization.read'));
