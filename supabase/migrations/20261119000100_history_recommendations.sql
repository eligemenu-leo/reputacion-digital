-- =============================================================================
-- Carga del histórico y recomendaciones de Facebook
--  * provider_sync_runs.trigger admite 'history' (carga del histórico pedida a mano).
--  * external_interactions.recommendation: las recomendaciones de Facebook no
--    tienen nota 1–5; se guarda si el autor recomienda o no.
-- =============================================================================
alter table public.provider_sync_runs drop constraint provider_sync_runs_trigger_check;
alter table public.provider_sync_runs add constraint provider_sync_runs_trigger_check
  check (trigger in ('schedule', 'manual', 'webhook', 'recovery', 'history'));

alter table public.external_interactions
  add column recommendation text check (recommendation in ('positive', 'negative'));
