-- =============================================================================
-- Migración 0005 · Fase 3 (segundo bloque): informes con métricas y resumen IA
--
-- report_snapshots guarda, de forma inmutable, las MÉTRICAS OBSERVADAS que
-- calcula el backend para un cliente y periodo, y (si procede) el resumen y
-- los hallazgos que redactó la IA a partir SOLO de esas métricas y de
-- ejemplos citables. La interfaz distingue ambas cosas.
-- =============================================================================

alter table public.ai_generations drop constraint ai_generations_kind_check;
alter table public.ai_generations add constraint ai_generations_kind_check
  check (kind in ('classification', 'draft', 'summary'));

create table public.report_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  period_start date not null,
  period_end date not null,
  status text not null check (status in ('ready', 'metrics_only', 'insufficient_sample', 'blocked', 'failed')),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  summary jsonb check (summary is null or jsonb_typeof(summary) = 'object'),
  warnings text[] not null default '{}',
  status_reason text check (char_length(status_reason) <= 500),
  ai_generation_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint report_snapshots_period check (period_end >= period_start and period_end - period_start <= 366),
  constraint report_snapshots_summary_status check ((status = 'ready') = (summary is not null)),
  constraint report_snapshots_client_fk foreign key (organization_id, client_id)
    references public.clients (organization_id, id) on delete cascade,
  constraint report_snapshots_generation_fk foreign key (organization_id, client_id, ai_generation_id)
    references public.ai_generations (organization_id, client_id, id) on delete restrict
);
create index report_snapshots_client_idx on public.report_snapshots (client_id, created_at desc);
create trigger report_snapshots_append_only before update on public.report_snapshots
  for each row execute function private.forbid_mutation();

revoke all on public.report_snapshots from anon, authenticated;
grant select on public.report_snapshots to authenticated;
grant all on public.report_snapshots to service_role;
alter table public.report_snapshots enable row level security;
create policy report_snapshots_select on public.report_snapshots for select to authenticated
  using (private.has_client_permission_in(organization_id, client_id, 'reports.read'));

-- Consultas de métricas por cliente y periodo.
create index external_interactions_client_period_idx
  on public.external_interactions (client_id, original_created_at);
