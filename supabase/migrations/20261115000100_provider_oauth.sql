-- =============================================================================
-- Fase 4 · Bloque 1 — OAuth de proveedores y credenciales cifradas
--
-- * private.oauth_states: estado de un intento de autorización (un solo uso,
--   10 minutos). Se guarda el hash del `state`, nunca el valor en claro.
-- * private.provider_credentials: tokens OAuth sellados con AES-256-GCM por la
--   API (ADR-024). La clave está fuera de la base de datos; ni anon ni
--   authenticated tienen privilegios sobre el esquema private.
-- * connected_accounts.credential_id: enlaza la fuente con su credencial. No se
--   expone a authenticated (los privilegios de columna son explícitos).
-- * Una fuente real no puede estar «conectada» sin credencial.
-- =============================================================================

create table private.oauth_states (
  state_hash text primary key check (char_length(state_hash) = 64),
  provider text not null check (provider in ('google_business_profile', 'facebook_page', 'instagram_business')),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Verificador PKCE sellado (igual que los tokens).
  code_verifier_sealed text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz
);
create index oauth_states_expires_idx on private.oauth_states (expires_at);

create table private.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Cliente para el que se autorizó (la selección de ubicaciones se limita a él).
  client_id uuid not null references public.clients (id) on delete cascade,
  provider text not null check (provider in ('google_business_profile', 'facebook_page', 'instagram_business')),
  -- Formato: v1.<kid>.<iv>.<tag>.<datos>, AAD = id de la fila.
  sealed text not null check (sealed like 'v1.%'),
  key_id text not null,
  scopes text[] not null default '{}',
  access_expires_at timestamptz,
  authorized_by uuid references auth.users (id) on delete set null,
  authorized_at timestamptz not null default now(),
  refreshed_at timestamptz,
  revoked_at timestamptz,
  last_error_kind text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provider_credentials_org_idx on private.provider_credentials (organization_id, provider);
create trigger provider_credentials_updated_at before update on private.provider_credentials
  for each row execute function private.set_updated_at();

alter table public.connected_accounts
  add column credential_id uuid references private.provider_credentials (id) on delete set null;
create index connected_accounts_credential_idx on public.connected_accounts (credential_id)
  where credential_id is not null;

-- «No presentar como activa una integración que no tenga credenciales válidas.»
alter table public.connected_accounts add constraint connected_accounts_real_needs_credential check (
  provider in ('simulator', 'rss', 'web_search')
  or status in ('disconnected', 'pending_authorization', 'credentials_expired', 'insufficient_access')
  or credential_id is not null
);

revoke all on private.oauth_states, private.provider_credentials from public, anon, authenticated;
grant select, insert, update, delete on private.oauth_states, private.provider_credentials to service_role;
