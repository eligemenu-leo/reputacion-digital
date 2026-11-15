-- =============================================================================
-- Fase 4 · Bloque 2 (ajuste) — Autorización de Meta por organización
--
-- Una agencia conecta su cuenta de Meta una sola vez y asigna cada página o
-- cuenta de Instagram al cliente que corresponda (ADR-028). La credencial de
-- Meta deja de estar atada a un cliente; la de Google sigue estándolo.
-- =============================================================================

alter table private.provider_credentials alter column client_id drop not null;
alter table private.provider_credentials add constraint provider_credentials_client_scope
  check (provider = 'meta' or client_id is not null);

alter table private.oauth_states alter column client_id drop not null;
alter table private.oauth_states add constraint oauth_states_client_scope
  check (provider = 'meta' or client_id is not null);
