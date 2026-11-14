# Modelo de datos

Fuente de verdad: `supabase/migrations/*.sql`. Este documento explica el diseño y anticipa las tablas de fases posteriores (marcadas con la fase en la que se crearán).

## Reglas generales

* PK `uuid` (`gen_random_uuid()`), salvo tablas de alto volumen append-only (`audit_logs`, `ai_usage`) con `bigint identity`.
* Todas las fechas `timestamptz` (UTC). La zona horaria de presentación sale de `profiles.timezone`, `clients.timezone` o `client_locations.timezone`.
* **Toda tabla de tenant lleva `organization_id`** y las FK hacia clientes/ubicaciones son **compuestas** `(organization_id, client_id) → clients(organization_id, id)`. Así es imposible, incluso con service_role, enlazar una fila de la organización A con un cliente de la B.
* `organization_id` y `client_id` son **inmutables** tras crearse (trigger `private.prevent_tenant_change`).
* RLS activada en todas las tablas de `public` (un test lo comprueba).
* Auditoría automática por trigger en tablas de configuración; tablas de evidencia (`audit_logs`, `brand_profile_versions`, `response_approvals`, `publication_receipts`) son append-only.
* Referencias externas siempre como `(provider, connected_account_id, external_id)` con `UNIQUE` para deduplicar.
* Ningún token OAuth en tablas accesibles por `authenticated` (ver «Credenciales»).

## Jerarquía

```
organizations ─┬─ organization_members ── roles ── role_permissions ── permissions
               ├─ clients ─┬─ client_locations ── connected_account_locations ─┐
               │           ├─ client_members (asignación + rol extra por cliente) │
               │           ├─ brand_profiles ── brand_profile_versions           │
               │           └─ connected_accounts ────────────────────────────────┘
               │                └─ provider_sync_runs
               │                └─ external_interactions ─┬─ interaction_versions
               │                                          ├─ interaction_analyses ── interaction_topics ── topics
               │                                          └─ response_drafts ─┬─ response_approvals
               │                                                              └─ publication_jobs ── publication_attempts
               │                                                                                  └─ publication_receipts
               ├─ alert_rules ── alerts ── notifications
               ├─ search_queries ── public_mentions
               └─ ai_generations ── ai_usage
audit_logs · platform_admins · platform_settings · profiles (1:1 auth.users)
```

## Fase 1 (implementado)

| Tabla | Propósito | Claves / notas |
|---|---|---|
| `profiles` | Datos de usuario visibles (nombre, idioma, zona horaria) | PK = `auth.users.id`; creada por trigger al registrarse |
| `platform_admins` | Superadministradores | fuera del modelo de organización; solo alta por SQL/servicio |
| `organizations` | Agencia/empresa cliente de la plataforma | `slug` único, `status`, `publishing_paused`, `require_admin_mfa` |
| `permissions` | Catálogo de permisos | `key` (p. ej. `responses.approve`), `scope` platform/organization/client |
| `roles` | Roles de sistema (`organization_id` NULL) o personalizados | `UNIQUE NULLS NOT DISTINCT (organization_id, key)` |
| `role_permissions` | N:M rol↔permiso | políticas impiden permisos `platform.*` en roles de organización |
| `organization_members` | Pertenencia + rol de organización | `UNIQUE (organization_id, user_id)`, `all_clients_access`, `status` |
| `clients` | Cliente gestionado | `UNIQUE (organization_id, id)` para FK compuestas; responsable con FK compuesta a miembros |
| `client_locations` | Establecimientos | una sola `is_primary` por cliente (índice parcial único) |
| `client_members` | Asignación usuario↔cliente (+ rol adicional, p. ej. `approver`) | FK compuesta a `organization_members` |
| `brand_profiles` / `brand_profile_versions` | Personalidad de marca versionada | versiones inmutables, `UNIQUE (brand_profile_id, version)` |
| `platform_settings` | Ajustes globales | `publishing_kill_switch` |
| `audit_logs` | Registro de cambios | append-only, diff por columna, claves sensibles redactadas |

### Modelo de permisos efectivo

```
permiso(usuario, cliente) =
     superadmin
  ∨ ( miembro activo de la organización activa
      ∧ ( (all_clients_access ∨ asignado al cliente) ∧ rol_organización tiene permiso
          ∨ asignado al cliente con rol_extra que tiene permiso ) )
```

Implementado en `private.has_client_permission_in(org, client, perm)` (SECURITY DEFINER, `search_path=''`). Roles de sistema:

| Rol | Alcance típico | Permisos clave |
|---|---|---|
| `org_admin` | toda la organización | todos los de scope organization+client |
| `account_manager` | clientes asignados | leer/editar cliente, bandeja, borradores, solicitar aprobación, informes |
| `approver` | rol **extra** por cliente | `responses.approve` |
| `client_viewer` | (fase posterior) | lectura e informes |

## Fase 2 (implementado) — `20261114000100_inbox_workflow.sql`

| Tabla | Propósito | Escritura |
|---|---|---|
| `connected_accounts` | Fuente conectada por cliente (y ubicación opcional). `provider`, `status` (conectada, caducada, error temporal…), `is_simulated` (solo `provider = 'simulator'`, impuesto por CHECK), `config` (no secreta, oculta a usuarios), programación (`next_run_at`), último error | API (service_role) tras `connections.manage` |
| `provider_sync_runs` | Cada sincronización: disparador (manual, programada, webhook, recuperación), estado, contadores (leídas, nuevas, actualizadas, errores), motivo de fallo. Índice único parcial: una sola ejecución activa por cuenta | worker |
| `external_interactions` | Interacción normalizada. Deduplicación `unique nulls not distinct (provider, connected_account_id, external_id)`. Estado, prioridad 1-4, responsable, banderas de riesgo, `requires_specialist`, respuesta existente, `is_simulated`, columna generada `search` (tsvector + GIN) | worker (ingesta), API (flujo) |
| `interaction_versions` | Cada contenido observado del original (detecta ediciones del autor). Append-only | worker |
| `response_drafts` | Borradores versionados `(interaction_id, version)` con `content_hash` (SHA-256 del texto exacto). Sin UPDATE | API |
| `response_approvals` | Decisiones `approved / rejected / returned` ligadas a `draft_id` + `content_hash`, con nota y confirmación de revisión especializada. Append-only | API (`responses.approve`) |
| `publication_jobs` | Trabajo de publicación con el texto congelado, `idempotency_key` única, estado, intentos, último error | API (al aprobar), worker |
| `publication_attempts` | Cada llamada: `publish` o `status_check` (consulta previa al reintento), resultado | worker |
| `publication_receipts` | Verificación final: id externo, hash del texto visible, estado del proveedor. Append-only | worker |
| `interaction_events` | Historial completo de la interacción (estado origen/destino, actor persona o sistema, datos). Append-only | API, worker |
| `private.interaction_transitions` | Pares de estados permitidos; un test verifica que coincide con `packages/shared` | — |
| `private.simulator_items`, `private.simulator_remote` | «Lado remoto» del simulador (reseñas ficticias y respuestas publicadas). Inaccesible para usuarios | simulador |

**Invariantes impuestas por la base de datos** (aunque el código fallara):

1. `private.guard_interaction_state`: solo transiciones de la tabla `interaction_transitions` (SQLSTATE 23514).
2. `private.guard_publication_job` (al insertar un trabajo): la **última** decisión de la interacción debe ser una aprobación, sobre el **último** borrador, y `sha256(content)` debe coincidir con el hash aprobado (42501). Por eso editar el texto después de aprobar anula la aprobación sin posibilidad de saltársela.
3. `publication_jobs_one_live`: como máximo un trabajo `queued/running/published` por interacción → no hay segunda publicación accidental.
4. `private.freeze_publication_job`: el texto, el borrador, la aprobación y la clave idempotente no cambian; `published` es terminal.
5. Borradores, decisiones, versiones, recibos e historial son append-only (`private.forbid_mutation`).
6. `authenticated` solo tiene `SELECT` (filtrado por RLS: `connections.read` o `interactions.read` sobre el cliente). Toda mutación pasa por la API tras comprobar permisos y por el worker.

**Índices:** `(organization_id, state, original_created_at desc)` para la bandeja, `(client_id, original_created_at desc)`, `(assignee_id)` parcial para abiertas, GIN sobre `search`, `(interaction_id, id)` en eventos, `(status, updated_at)` en trabajos.

## Fases siguientes (diseño)

### Fase 3 — IA (implementado: `20261114000200_ai_assist.sql`)

| Tabla / columna | Propósito | Invariantes |
|---|---|---|
| `ai_generations` | Cada llamada o intento bloqueado: tipo, proveedor, modelo, versión de prompt, versión de marca, variante, `input_hash`, salida validada, avisos, tokens, coste estimado y real, latencia, intentos | nace `running`; solo puede cerrarse una vez (`private.guard_ai_generation`); columnas de identidad inmutables; `authenticated` solo lee (`interactions.read`) |
| `ai_budgets` | Límite mensual (USD) y corte automático por organización | sin fila = 10 USD con corte; escritura solo vía API (`organization.manage`) |
| `external_interactions.ai_status` (`not_requested · pending · running · done · failed · skipped`), `ai_attempts`, `ai_error`, `ai_classification_id`, `topics`, `ai_confidence`, `requires_response` | Resultado y estado del análisis; `pending` es la fuente de verdad del outbox de clasificación | índice parcial sobre `pending/running` |
| `response_drafts.ai_generation_id` | Trazabilidad del borrador generado | FK compuesta; `source = 'ai'` ⇔ hay generación |
| `platform_settings.ai_real_data_allowed` | Guarda del DPA (ADR-021) | por defecto `false` |

| `report_snapshots` (`20261114000300_reports.sql`) | Informe por cliente y periodo: métricas observadas (jsonb), estado (`ready · metrics_only · insufficient_sample · blocked · failed`), resumen y hallazgos de IA, avisos, generación | append-only; `ready` ⇔ hay resumen; periodo ≤ 366 días; lectura con `reports.read` |

Las tendencias por tema se calculan al vuelo desde `external_interactions.topics` (índice `(client_id, original_created_at)`); el consumo de IA, desde `ai_generations`.

### Fase 4 — Integraciones

```sql
connected_accounts (id, organization_id, client_id, provider, external_account_id, display_name,
                    status connection_status, granted_scopes text[], authorized_at, authorized_by,
                    last_success_sync_at, last_attempt_at, next_run_at, last_error_kind, last_error_message,
                    unique (provider, external_account_id, client_id))
connected_account_locations (connected_account_id, location_id, external_location_id, can_reply, ineligibility_reason)
provider_capabilities (provider, capability, supported, notes, verified_at)   -- catálogo
provider_sync_runs (id, organization_id, client_id, connected_account_id, trigger 'cron'|'manual'|'webhook',
                    started_at, finished_at, status, found, created, updated, errors, failure_reason, cursor)
webhook_events (provider, event_id, received_at, payload_hash, processed_at, unique(provider, event_id))
search_queries (id, organization_id, client_id, brand_name, variants text[], keywords text[], domain,
                exclusions text[], geo_hint, languages text[], provider, schedule)
public_mentions (id, organization_id, client_id, search_query_id, provider, url_normalized, title, excerpt,
                 published_at, observed_at, content_hash, source_domain, analysis_id,
                 unique (client_id, url_normalized))
```

**Credenciales:** `private.connected_account_credentials (connected_account_id pk, secret_id uuid → vault.secrets)`. Los tokens se guardan con Supabase Vault (cifrado en reposo con clave gestionada fuera de la BD); el esquema `private` no se expone por la API REST y `authenticated` no tiene privilegios. Solo el worker/API con `service_role` los descifra en memoria.

### Fase 5 — Alertas e informes

```sql
alert_rules (id, organization_id, client_id null, event_type, conditions jsonb, severity, channels text[],
             group_window interval, escalation jsonb, enabled)
alerts (id, organization_id, client_id, rule_id, event_type, severity, group_key, first_at, last_at,
        occurrences int, status 'open'|'acknowledged'|'resolved', unique(rule_id, group_key) where status='open')
notifications (id, alert_id, user_id, channel 'in_app'|'email', sent_at, read_at, error)
report_snapshots (id, organization_id, client_id, period, metrics jsonb, ai_summary_generation_id)
```

`reputation_score` **no** se implementa en el MVP; `report_snapshots.metrics` reserva la estructura para definirlo y validarlo después.

## Conservación de datos (propuesta, a validar con el DPO de cada agencia)

| Dato | Plazo | Motivo |
|---|---|---|
| Interacciones y respuestas | vida del contrato + 12 meses | prestación del servicio, histórico |
| Autor (nombre visible) | igual que la interacción; `author_ref_hash` seudonimizado | minimización |
| `audit_logs` | 24 meses | responsabilidad proactiva (RGPD art. 5.2) |
| `ai_generations.output` | 12 meses; métricas agregadas indefinidas | trazabilidad / coste |
| `webhook_events` | 30 días | deduplicación |
| Tokens OAuth | hasta desconexión/revocación (borrado inmediato) | necesidad |

Un job de retención (F5) aplicará estos plazos; el borrado de una organización elimina en cascada sus datos.
