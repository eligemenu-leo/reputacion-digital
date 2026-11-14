# Plan de pruebas

## Cómo ejecutar

```bash
# PostgreSQL ≥ 15 accesible (por defecto postgres://postgres@localhost:54329/postgres)
export TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:54329/postgres
pnpm test            # unitarias + RLS + integración API (recrea la BD de pruebas)
pnpm lint && pnpm typecheck && pnpm format:check

# E2E contra el stack local real (Supabase + API + web en marcha)
npx supabase start
pnpm --filter @rep/api build
node --env-file=apps/api/.env apps/api/dist/server.js & node --env-file=apps/api/.env apps/api/dist/worker.js &
pnpm --filter @rep/web dev &
node apps/web/e2e/phase1-smoke.mjs      # Fase 1 (requiere Mailpit)
node apps/web/e2e/phase2-smoke.mjs      # Fase 2 (usa el worker real)
node apps/web/e2e/phase3-smoke.mjs      # Fase 3 (IA: OpenAI si hay clave, o AI_PROVIDER=fake)
```

## Niveles

| Nivel | Herramienta | Dónde | Estado F2 |
|---|---|---|---|
| Unitarias | Vitest | `packages/*/src/*.test.ts`, `apps/api/src/**/*.test.ts`, `apps/web/src/**/*.test.tsx` | 23 ✅ |
| Políticas RLS | Vitest + PostgreSQL (shim) | `apps/api/test/rls` | 34 ✅ |
| Integración API y flujo | Vitest + `fastify.inject` + PostgreSQL + manejadores del worker | `apps/api/test/api` | 45 ✅ |
| E2E | Playwright contra Supabase local real + worker pg-boss | `apps/web/e2e/phase{1,2}-smoke.mjs` | 10 + 9 pasos ✅ |
| Lint migraciones | `supabase db lint` | local | 0 avisos ✅ |
| Accesibilidad | axe + revisión manual | F6 | ⏳ |
| Rendimiento | Lighthouse CI (LCP), k6 (p95 API) | F6 | ⏳ |

## Cobertura (Fases 1 y 2)

**Unitarias:** máquina de estados (no publicar sin aprobar, editar invalida aprobación, `published` terminal, reintento solo tras error), validación de entradas (URLs peligrosas, campos inyectados, zonas horarias, slugs), deduplicación (hash de contenido, clave por cuenta, normalización de URLs), accesibilidad del componente `Field`.

**RLS (adversariales):** aislamiento total entre organizaciones en todas las tablas; usuario sin organización no ve nada; `anon` sin acceso; gestor solo ve clientes asignados; no puede editar otros, crear clientes ni escalar privilegios; rol de aprobación por cliente no se extiende a otros; roles personalizados no reciben permisos de plataforma; roles de sistema inmutables; último admin protegido; suspensión de miembro u organización corta el acceso al instante; FK compuestas impiden mezclar tenants; `organization_id` inmutable incluso para service_role; auditoría registra actor y diff, es inmutable y solo legible con `audit.read`; redacción de secretos; versiones de marca inmutables; interruptor global no modificable por usuarios; catálogo SQL = TypeScript; todas las tablas con RLS; todas las funciones SECURITY DEFINER con `search_path`.

**Integración API:** 401 sin token, con firma manipulada, caducado o `alg=none`; `/me` con permisos efectivos; 403/404 entre tenants; inyección de `organizationId` rechazada; validación (400) con detalles; búsqueda con comodines escapados; paginación; ubicación principal única; archivado; resumen con datos reales y módulos «no disponibles»; MFA (aal2) obligatorio para gestión de miembros y alta de organizaciones; invitación no simulada si no hay proveedor de email (501, sin crear nada); alta de organización con propietario existente auditada; activación de invitaciones al iniciar sesión sin reactivar suspendidos.

**Fase 2 · unitarias:** conector simulador (paginación, datos marcados como ficticios, capacidades reales, modos ambiguo/límite/credenciales), triaje (prioridad, riesgos, inyección).

**Fase 2 · RLS:** otra organización no ve fuentes, interacciones ni historial; el gestor solo ve sus clientes; `config` de las fuentes ilegible; usuarios sin escritura en tablas de flujo ni acceso al remoto simulado; FK impide mezclar fuente y cliente; solo el simulador puede marcar datos simulados.

**Fase 2 · integración y flujo** (`test/api/inbox.test.ts`, ejecutando los manejadores reales del worker): tabla SQL de transiciones = TypeScript; solo `connections.manage` crea fuentes; sincronización sin duplicados y con petición repetida idempotente; triaje y marca de simulado; **fallo de un conector sin afectar a los demás** y estado de cuenta correcto; barrido programa sincronizaciones vencidas; filtros, búsqueda, orden y paginación; aislamiento entre organizaciones y clientes; asignación y prioridad con historial; lotes por elemento y sin aprobación por lotes; **flujo completo publicado una sola vez y verificado**; aviso duplicado no republica; **editar después de aprobar invalida y cancela**; la BD rechaza publicar sin aprobación, con aprobación antigua o saltando estados; rechazo/devolución con motivo; revisión especializada obligatoria; **respuesta ambigua → consulta remota sin duplicar**; error definitivo → reintento manual que consulta antes de publicar; límite de peticiones con espera; **interruptor global y pausa de organización** bloquean sin perder el trabajo; edición de la reseña por su autor durante la revisión → vuelve a borrador; resumen y auditoría con datos reales.

**E2E Fase 2 (Supabase real + worker):** fuente simulada → sincronización por el worker → bandeja con filtros y búsqueda → asignación por lotes → gestor redacta y solicita (sin poder aprobar) → aprobadora en móvil → edición que anula la solicitud → aprobación → worker publica una vez y verifica → panel y modo oscuro.

**E2E (Supabase real):** login superadmin → bloqueo por MFA → alta TOTP real → creación de organización → email de invitación real (Mailpit) → aceptación y contraseña → panel → MFA del admin → alta de cliente → ubicación → auditoría → aislamiento → modo oscuro → móvil.

**Fase 3 · unitarias** (`apps/api/src/ai/ai.test.ts`): neutralización de delimitadores, invisibles y controles; enmascarado; similitud; validación de borradores (enlaces, emails, teléfonos, prohibidas, longitud, repetición); JSON Schema estrictos; prompts sin autor y con un único bloque `<interaction>`; reglas posteriores (nunca bajan prioridad); costes; configuración (`fake` prohibido en producción); cliente OpenAI con `fetch` simulado (petición estricta sin herramientas y `store: false`, clasificación de errores).

**Fase 3 · integración y flujo** (`test/api/ai.test.ts`, proveedor simulado): permisos y versionado de la marca; sincronización → aviso → clasificación de 12 reseñas ficticias; riesgo sanitario crítico; intento de manipulación marcado; registro de generaciones con coste; caché sin nueva llamada; reintentos y error visible; barrido de avisos perdidos; sin marca no se genera; borrador IA trazado a la versión de marca y **sin publicación** hasta aprobación; variante tras aprobar invalida y cancela; rechazo y reintento por enlace, teléfono o expresión prohibida; datos verificados permitidos; salida fuera de esquema; IA desactivada por cliente o en el entorno; presupuesto (permisos, bloqueo sin llamada, sin corte, modelo sin precio); **guarda del DPA**; RLS e inmutabilidad de las tablas de IA.

**Fase 3 · informes** (`test/api/reports.test.ts`): totales, media, distribución, sentimiento, temas y periodo anterior exactos; periodo inválido y aislamiento; resumen solo con cifras de las métricas y hallazgo con 3 reseñas; sin autor en el prompt; informe inmutable y RLS; cifra inventada → reintento y sin resumen; hallazgos sin respaldo o de temas inexistentes descartados; muestra < 10 sin llamada; permisos; sin IA → solo métricas; guarda del DPA.

**E2E Fase 3:** marca → fuente simulada → clasificación por el worker → sentimiento en la bandeja → análisis de salud y de manipulación → «Generar con IA» y «Más breve» → envío a aprobación sin publicar → la aprobadora ve el aviso de IA → informe con métricas y resumen de IA → coste registrado.

## Escenarios E2E pendientes (spec §13)

| # | Escenario | Fase |
|---|---|---|
| 1-3 | Crear organización, cliente, asignar usuario | ✅ F1 (asignación cubierta por API) |
| 4 | Configurar personalidad | F3 |
| 5-6 | Conectar simulador, recibir reseña | ✅ F2 |
| 7-8 | Analizar y generar respuesta IA | F3 |
| 9-13 | Modificar, aprobar, publicar (conector de prueba), verificar, auditar | ✅ F2 |
| 14 | Alerta por fallo de publicación | F5 |

## Pruebas adversariales pendientes

* Reseña maliciosa que intenta ordenar acciones a la IA (F3).
* ✅ Reintentos que no duplican publicaciones (F2, simulador ambiguo).
* ✅ Fallo parcial de un conector sin afectar a los demás (F2, simulador).
* Credencial revocada real que no aparenta funcionar (F4; simulada ✅ en F2).
* Logs del worker sin tokens: el simulador no usa tokens; revisar con conectores reales (F4).
