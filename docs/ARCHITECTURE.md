# Arquitectura

> Estado: Fase 0 cerrada, Fase 1 implementada. Ver `PROGRESS.md` para el detalle de lo construido.

## 1. Visión general

```
                ┌──────────────────────────── Navegador ────────────────────────────┐
                │  apps/web  (React 19 + Vite + Tailwind 4, SPA)                     │
                │   · Supabase Auth (solo login / MFA / recuperación)                │
                │   · Todas las lecturas y escrituras de negocio → API propia        │
                └──────────────┬──────────────────────────────┬──────────────────────┘
                               │ Bearer JWT (Supabase)        │ OAuth (Fase 4)
                ┌──────────────▼──────────────┐      ┌────────▼────────┐
                │  apps/api  (Fastify 5, TS)  │      │ Google / Meta   │
                │  · verificación JWT (JWKS)  │◄────►│  (webhooks)     │
                │  · validación Zod           │      └────────▲────────┘
                │  · autorización en servidor │               │
                │  · withUser → RLS           │      ┌────────┴────────┐
                │  · withService → auditado   │      │ apps/worker     │
                └──────────────┬──────────────┘      │ pg-boss (Fase 2+)│
                               │                     │ sync / IA / pub. │
                ┌──────────────▼─────────────────────┴─────────────────┴──┐
                │ PostgreSQL (Supabase)                                    │
                │  public: datos de tenant con RLS     private: funciones  │
                │  auth: usuarios (Supabase)           private: tokens     │
                │  pgboss: colas persistentes (F2)                         │
                └──────────────────────────────────────────────────────────┘
```

**Principio rector:** defensa en profundidad. Cada petición se autoriza en el servidor **y** la base de datos vuelve a aplicar RLS con la identidad del usuario. Un fallo en la UI o en un endpoint no puede exponer datos de otra organización.

## 2. Monorepo

```
reputacion-digital/
├─ apps/
│  ├─ web/                 SPA React (Vite). features/<dominio>/…, components/ui, layouts
│  ├─ api/                 API HTTP Fastify + worker (dos procesos, mismo código de dominio)
│  │  ├─ src/routes/       <dominio>.ts (HTTP)
│  │  ├─ src/domain/       workflow, sync, publish, triage, conectores, colas (compartido API/worker)
│  │  ├─ src/server.ts     proceso API · src/worker.ts proceso worker (pg-boss)
│  │  └─ test/             rls/ (políticas) · api/ (integración HTTP + flujo con worker)
├─ packages/
│  ├─ shared/              Contratos compartidos: permisos, esquemas Zod, errores,
│  │                       máquina de estados de interacción, utilidades de fecha
│  └─ connectors/          Contrato común de conectores, deduplicación y SimulatorConnector (F2).
│                          (F4) google-business-profile/, meta-facebook/, meta-instagram/, web-search/, rss/
├─ supabase/
│  ├─ config.toml          Configuración del stack local (Supabase CLI)
│  ├─ migrations/          Migraciones SQL versionadas (única fuente del esquema)
│  └─ tests/               Shim para ejecutar migraciones en PostgreSQL sin Supabase
├─ scripts/                db-reset-test.sh
└─ docs/                   Documentación obligatoria (este directorio)
```

## 3. Dominios y contratos

| # | Dominio | Dónde vive | Contrato |
|---|---|---|---|
| 1 | Identity & Access | `supabase/migrations/*identity*`, `api/lib/{auth,authz}.ts` | `PERMISSIONS`, `private.has_*_permission` |
| 2 | Organizations & Clients | `api/routes/{organizations,clients,members}.ts` | esquemas Zod en `shared/schemas.ts` |
| 3 | Connected Accounts | (F4) `api/routes/connections.ts`, tabla `connected_accounts`, `vault` | credenciales cifradas, nunca en cliente |
| 4 | Provider Connectors | `packages/connectors` | `ProviderConnector` (`contract.ts`) |
| 5 | Monitoring & Ingestion | (F2/F4) `apps/worker/jobs/sync-*` | `provider_sync_runs`, dedupe key |
| 6 | Reputation Inbox | (F2) `api/routes/interactions.ts` | `NormalizedInteraction`, estados |
| 7 | AI Analysis | (F3) `apps/worker/ai/classify.ts` | salida JSON Schema validada |
| 8 | AI Response Generation | (F3) `apps/worker/ai/generate.ts` | prompts versionados |
| 9 | Approval Workflow | (F2) `api/routes/approvals.ts` | `nextInteractionState()` + trigger SQL |
| 10 | Publishing | (F2/F4) `apps/worker/jobs/publish.ts` | `publishReply` + `getPublicationStatus` |
| 11 | Alerts | (F5) | `alert_rules`, agrupación por clave |
| 12 | Reporting | (F5) | agregados SQL; la IA solo narra |
| 13 | Audit & Observability | trigger `private.audit_row_change`, logs Pino | `audit_logs` append-only |

La UI nunca consume formatos de Google o Meta: solo `NormalizedInteraction` y los DTO de la API.

## 4. Flujo de una petición

1. El navegador obtiene un JWT de Supabase Auth (contraseña + TOTP opcional/obligatorio).
2. La API verifica el JWT: claves asimétricas vía JWKS (`/auth/v1/.well-known/jwks.json`) o HS256 (solo local/legado). Rechaza `alg=none`, firmas inválidas, expirados y audiencia incorrecta.
3. El cuerpo/params se validan con Zod (`.strict()`: campos desconocidos → 400).
4. `withUser()` abre una transacción con `SET LOCAL ROLE authenticated` y `request.jwt.claims` → todas las consultas pasan por RLS.
5. Las comprobaciones explícitas (`requireOrgPermission`, `requireClientAction`) llaman a las **mismas funciones SQL** que las políticas: API y BD no pueden divergir.
6. Operaciones que exigen saltarse RLS (alta de organizaciones, futuros jobs) usan `withService()` (`service_role`) **solo después** de una comprobación explícita, y conservan el actor en los claims para la auditoría.
7. Errores de dominio → `{ error: { code, message, details, requestId } }`. Errores de BD se traducen (`42501`→403, `23505`→409…) sin filtrar detalles internos.

## 5. Procesamiento asíncrono (implementado en F2)

* **Cola:** `pg-boss` 12 sobre la misma base de datos (esquema `pgboss`). El worker es un segundo punto de entrada del paquete `apps/api` (`src/worker.ts`, ADR-013).
* **Patrón outbox:** la fuente de verdad son las filas (`provider_sync_runs.status = 'queued'`, `publication_jobs.status = 'queued'`), creadas en la misma transacción que la acción del usuario. El aviso a la cola se envía después del commit; si se pierde, el barrido (`maintenance.sweep`, cada minuto) lo vuelve a encolar. Los manejadores reclaman la fila con `UPDATE … WHERE status = 'queued'`, así que los avisos duplicados no hacen nada.
* **Colas:** `sync.account` (concurrencia 4), `publish.reply` (concurrencia 2), `maintenance.sweep` (cron, singleton). En F3-F5 se añadirán `ai.*`, `alerts.evaluate`, `reports.summarize`.
* **Sincronización:** incremental con ventana solapada de 15 min (`since = última correcta − 15 min`); la deduplicación por `(provider, cuenta, external_id)` absorbe el solape. Si el hash del contenido cambia se guarda una versión nueva y, si había una respuesta en revisión o aprobada, se vuelve a borrador. Cada cuenta en su propio trabajo: el fallo de una no afecta al resto; el estado de la cuenta refleja el tipo de error (credenciales caducadas, acceso insuficiente, error temporal).
* **Publicación segura** (`domain/publish.ts`):
  1. Reclama el trabajo y comprueba que la aprobación sigue siendo la última, del último borrador y del mismo texto; si no, lo cancela.
  2. Consulta `publishing_kill_switch` y `organizations.publishing_paused`; si están activos deja el trabajo en cola (intento `blocked`) sin fallar.
  3. Si es un reintento (`attempts > 1`), **consulta primero el estado remoto** (`getPublicationStatus`); si ya está publicado con el texto aprobado, lo confirma sin volver a enviar.
  4. Publica con `idempotencyKey = pub-<approval_id>`; ante respuesta ambigua consulta el estado remoto antes de decidir.
  5. Verifica el texto visible y guarda el recibo; errores reintentables se reprograman con backoff (o `Retry-After`), los definitivos quedan en `publish_failed` para reintento manual.
* **Recuperación:** trabajos `running` > 10 min vuelven a `queued` (el siguiente intento consultará antes de publicar); sincronizaciones `running` > 30 min se marcan fallidas.

## 6. Entornos

| Entorno | Base de datos | Auth | Notas |
|---|---|---|---|
| local | `supabase start` (Docker) o PostgreSQL + shim para tests | GoTrue local | Inbucket/Mailpit para emails |
| CI | PostgreSQL 17 (servicio) + shim | JWT HS256 de pruebas | sin secretos reales |
| staging | Proyecto Supabase dedicado | JWKS | datos ficticios, apps de Google/Meta en modo desarrollo |
| producción | Proyecto Supabase dedicado (UE) | JWKS + MFA obligatorio admins | PITR activado |

La API y el worker son procesos Node sin estado empaquetables en contenedor (Fly.io, Render, Railway, Cloud Run, ECS…). La web es estática (cualquier CDN). Nada depende de una plataforma visual de desarrollo.

## 7. Rendimiento

* Índices en todas las FK de consulta frecuente y en `(organization_id, status)`, `(organization_id, lower(name))`.
* Funciones de autorización `STABLE` + `(select auth.uid())` en políticas para que el planificador las evalúe una vez por consulta.
* Paginación por `limit/offset` en listados pequeños (clientes) y por *keyset* en listados grandes (auditoría; bandeja en F2).
* Frontend: división de código por ruta y por vendor (bundle inicial ≈ 77 kB gzip + vendors cacheables).
* Objetivos medibles (LCP < 2,5 s, p95 API < 500 ms) se verificarán en Fase 6 con Lighthouse CI y k6; **todavía no están medidos**.
