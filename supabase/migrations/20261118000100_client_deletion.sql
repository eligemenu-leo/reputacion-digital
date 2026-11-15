-- =============================================================================
-- Borrado definitivo de un cliente y todos sus datos (ADR-029)
--
-- Las tablas de historial (versiones, aprobaciones, intentos, recibos, eventos)
-- son append-only y algunas claves son RESTRICT para que nada se borre por
-- accidente. El borrado de un cliente es la única excepción y solo ocurre dentro
-- de private.purge_client(), que:
--   * marca la transacción con app.purging_client = <id> (set_config local);
--   * los triggers append-only y de auditoría por fila lo respetan SOLO para
--     filas de ese cliente (audit_logs sigue sin poder borrarse nunca);
--   * borra en orden para no chocar con las claves RESTRICT;
--   * conserva el gasto de IA del cliente como total mensual agregado, para que
--     el presupuesto de la organización no «recupere» dinero ya gastado;
--   * deja UNA entrada de auditoría «clients.purge» con recuentos, sin contenido.
-- =============================================================================

insert into public.permissions (key, scope, description) values
  ('clients.delete', 'organization', 'Eliminar clientes con todos sus datos (irreversible)');

insert into public.role_permissions (role_id, permission_key)
select r.id, 'clients.delete' from public.roles r where r.key = 'org_admin' and r.is_system;

-- Gasto de IA de clientes eliminados (agregado por mes, sin contenido).
create table public.ai_spend_archive (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  month date not null,
  spent_usd numeric(12, 6) not null default 0 check (spent_usd >= 0),
  calls integer not null default 0 check (calls >= 0),
  primary key (organization_id, month)
);
revoke all on public.ai_spend_archive from anon, authenticated;
grant select on public.ai_spend_archive to authenticated;
grant all on public.ai_spend_archive to service_role;
alter table public.ai_spend_archive enable row level security;
create policy ai_spend_archive_select on public.ai_spend_archive for select to authenticated
  using (private.has_org_permission(organization_id, 'organization.read'));

-- ¿Esta fila pertenece al cliente que se está eliminando en esta transacción?
create or replace function private.purging(row_j jsonb, tbl text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('app.purging_client', true), ''), '-') =
         case when tbl = 'clients' then row_j ->> 'id' else row_j ->> 'client_id' end
$$;

create or replace function private.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and tg_table_name <> 'audit_logs' and private.purging(to_jsonb(old), tg_table_name) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

-- La auditoría por fila no copia el contenido de lo que se elimina en un purgado.
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
  if tg_op = 'DELETE' and private.purging(to_jsonb(old), tg_table_name) then
    return old;
  end if;
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

/**
 * Elimina el cliente y todo lo suyo. Lo llama solo la API (service_role), que
 * antes comprueba clients.delete y la confirmación por nombre. Devuelve los
 * recuentos y las credenciales que se quedaron sin fuentes, para liberarlas.
 */
create or replace function private.purge_client(p_org uuid, p_client uuid, p_actor uuid, p_request text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  counts jsonb;
  creds uuid[];
  cname text;
begin
  select name into cname from public.clients where id = p_client and organization_id = p_org for update;
  if cname is null then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.publication_jobs where client_id = p_client and status in ('queued', 'running')) then
    raise exception 'client has publications in progress' using errcode = '55006';
  end if;

  perform set_config('app.purging_client', p_client::text, true);

  select jsonb_build_object(
    'interactions', (select count(*) from public.external_interactions where client_id = p_client),
    'sources', (select count(*) from public.connected_accounts where client_id = p_client),
    'drafts', (select count(*) from public.response_drafts where client_id = p_client),
    'aiGenerations', (select count(*) from public.ai_generations where client_id = p_client),
    'reports', (select count(*) from public.report_snapshots where client_id = p_client)
  ) into counts;

  select coalesce(array_agg(distinct credential_id), '{}') into creds
    from public.connected_accounts where client_id = p_client and credential_id is not null;

  -- Gasto de IA: se conserva agregado por mes.
  insert into public.ai_spend_archive as a (organization_id, month, spent_usd, calls)
  select p_org, date_trunc('month', created_at)::date,
         sum(case when status = 'running' then coalesce(estimated_cost_usd, 0) else coalesce(cost_usd, 0) end),
         count(*) filter (where status <> 'blocked')
    from public.ai_generations where client_id = p_client
   group by 2
  on conflict (organization_id, month) do update
    set spent_usd = a.spent_usd + excluded.spent_usd, calls = a.calls + excluded.calls;

  -- Orden: lo que tiene claves RESTRICT hacia otras tablas del cliente, primero.
  delete from public.publication_receipts where client_id = p_client;
  delete from public.publication_attempts where client_id = p_client;
  delete from public.publication_jobs where client_id = p_client;
  delete from public.report_snapshots where client_id = p_client;
  delete from public.response_approvals where client_id = p_client;
  delete from public.response_drafts where client_id = p_client;
  update public.external_interactions set ai_classification_id = null where client_id = p_client;
  delete from public.ai_generations where client_id = p_client;
  delete from public.interaction_events where client_id = p_client;
  delete from public.interaction_versions where client_id = p_client;
  delete from public.external_interactions where client_id = p_client;
  delete from private.simulator_items where connected_account_id in
    (select id from public.connected_accounts where client_id = p_client);
  delete from private.simulator_remote where connected_account_id in
    (select id from public.connected_accounts where client_id = p_client);
  delete from public.provider_sync_runs where client_id = p_client;
  delete from public.connected_accounts where client_id = p_client;
  -- Credenciales ligadas al cliente (Google). Las de Meta son de la organización
  -- y se liberan después desde la API si ya no las usa ninguna fuente.
  delete from private.oauth_states where client_id = p_client;
  delete from public.clients where id = p_client;

  perform set_config('app.purging_client', '', true);

  insert into public.audit_logs (organization_id, client_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata, request_id)
  values (p_org, p_client, p_actor, case when p_actor is null then 'system' else 'user' end,
          'clients.purge', 'clients', p_client::text, counts, p_request);

  return jsonb_build_object('counts', counts, 'credentialIds', to_jsonb(creds));
end $$;

revoke all on function private.purge_client(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.purge_client(uuid, uuid, uuid, text) to service_role;
