-- =============================================================================
-- Fase 4 · Bloque 2 — Meta (páginas de Facebook e Instagram profesional)
--
-- * Un solo inicio de sesión de Meta ('meta') da acceso a páginas y a sus
--   cuentas de Instagram. La credencial guarda, sellados, el token de usuario
--   y los tokens de página (ADR-026).
-- * provider_user_ref: HMAC del id de usuario de Meta. Permite saber si otra
--   autorización vigente depende del mismo usuario antes de revocar la app.
-- * Facebook Login no usa PKCE: el verificador sellado pasa a ser opcional.
-- * private.webhook_events: avisos ya recibidos (Meta reintenta hasta 36 h),
--   para no procesar dos veces el mismo. Se conservan 7 días.
-- =============================================================================

alter table private.oauth_states drop constraint oauth_states_provider_check;
alter table private.oauth_states add constraint oauth_states_provider_check
  check (provider in ('google_business_profile', 'meta'));
alter table private.oauth_states alter column code_verifier_sealed drop not null;

alter table private.provider_credentials drop constraint provider_credentials_provider_check;
alter table private.provider_credentials add constraint provider_credentials_provider_check
  check (provider in ('google_business_profile', 'meta'));
alter table private.provider_credentials
  add column provider_user_ref text check (provider_user_ref is null or char_length(provider_user_ref) = 64);
create index provider_credentials_user_ref_idx on private.provider_credentials (provider, provider_user_ref)
  where provider_user_ref is not null;

create table private.webhook_events (
  provider text not null check (provider in ('facebook_page', 'instagram_business')),
  event_id text not null check (char_length(event_id) = 64),
  account_external_id text not null check (char_length(account_external_id) between 1 and 80),
  interaction_external_id text check (char_length(interaction_external_id) <= 120),
  event_type text not null,
  received_at timestamptz not null default now(),
  -- Fuentes a las que se encoló una sincronización por este aviso.
  matched_accounts integer not null default 0,
  primary key (provider, event_id)
);
create index webhook_events_received_idx on private.webhook_events (received_at);

revoke all on private.webhook_events from public, anon, authenticated;
grant select, insert, update, delete on private.webhook_events to service_role;
