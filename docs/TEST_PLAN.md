# Plan de pruebas

## Cómo ejecutar

```bash
# PostgreSQL ≥ 15 accesible (por defecto postgres://postgres@localhost:54329/postgres)
export TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:54329/postgres
pnpm test            # unitarias + RLS + integración API (recrea la BD de pruebas)
pnpm lint && pnpm typecheck && pnpm format:check

# E2E contra el stack local real (Supabase + API + web en marcha)
npx supabase start
pnpm --filter @rep/api dev & pnpm --filter @rep/web dev &
node apps/web/e2e/phase1-smoke.mjs
```

## Niveles

| Nivel | Herramienta | Dónde | Estado F1 |
|---|---|---|---|
| Unitarias | Vitest | `packages/*/src/*.test.ts`, `apps/web/src/**/*.test.tsx` | 16 ✅ |
| Políticas RLS | Vitest + PostgreSQL (shim) | `apps/api/test/rls` | 28 ✅ |
| Integración API | Vitest + `fastify.inject` + PostgreSQL | `apps/api/test/api` | 22 ✅ |
| E2E | Playwright contra Supabase local real | `apps/web/e2e/phase1-smoke.mjs` | 10 pasos ✅ |
| Lint migraciones | `supabase db lint` | local | 0 avisos ✅ |
| Accesibilidad | axe + revisión manual | F6 | ⏳ |
| Rendimiento | Lighthouse CI (LCP), k6 (p95 API) | F6 | ⏳ |

## Cobertura actual (Fase 1)

**Unitarias:** máquina de estados (no publicar sin aprobar, editar invalida aprobación, `published` terminal, reintento solo tras error), validación de entradas (URLs peligrosas, campos inyectados, zonas horarias, slugs), deduplicación (hash de contenido, clave por cuenta, normalización de URLs), accesibilidad del componente `Field`.

**RLS (adversariales):** aislamiento total entre organizaciones en todas las tablas; usuario sin organización no ve nada; `anon` sin acceso; gestor solo ve clientes asignados; no puede editar otros, crear clientes ni escalar privilegios; rol de aprobación por cliente no se extiende a otros; roles personalizados no reciben permisos de plataforma; roles de sistema inmutables; último admin protegido; suspensión de miembro u organización corta el acceso al instante; FK compuestas impiden mezclar tenants; `organization_id` inmutable incluso para service_role; auditoría registra actor y diff, es inmutable y solo legible con `audit.read`; redacción de secretos; versiones de marca inmutables; interruptor global no modificable por usuarios; catálogo SQL = TypeScript; todas las tablas con RLS; todas las funciones SECURITY DEFINER con `search_path`.

**Integración API:** 401 sin token, con firma manipulada, caducado o `alg=none`; `/me` con permisos efectivos; 403/404 entre tenants; inyección de `organizationId` rechazada; validación (400) con detalles; búsqueda con comodines escapados; paginación; ubicación principal única; archivado; resumen con datos reales y módulos «no disponibles»; MFA (aal2) obligatorio para gestión de miembros y alta de organizaciones; invitación no simulada si no hay proveedor de email (501, sin crear nada); alta de organización con propietario existente auditada; activación de invitaciones al iniciar sesión sin reactivar suspendidos.

**E2E (Supabase real):** login superadmin → bloqueo por MFA → alta TOTP real → creación de organización → email de invitación real (Mailpit) → aceptación y contraseña → panel → MFA del admin → alta de cliente → ubicación → auditoría → aislamiento → modo oscuro → móvil.

## Escenarios E2E pendientes (spec §13)

| # | Escenario | Fase |
|---|---|---|
| 1-3 | Crear organización, cliente, asignar usuario | ✅ F1 (asignación cubierta por API) |
| 4 | Configurar personalidad | F3 |
| 5-6 | Conectar simulador, recibir reseña | F2 |
| 7-8 | Analizar y generar respuesta IA | F3 |
| 9-13 | Modificar, aprobar, publicar (conector de prueba), verificar, auditar | F2 |
| 14 | Alerta por fallo de publicación | F5 |

## Pruebas adversariales pendientes

* Reseña maliciosa que intenta ordenar acciones a la IA (F3).
* Reintentos que no duplican publicaciones (F2: simulador con respuestas ambiguas).
* Credencial revocada que no aparenta funcionar (F4).
* Fallo parcial de un conector sin afectar a los demás (F2/F4).
* Logs sin tokens: ya probado para cabeceras y auditoría; ampliar a logs del worker (F2).
