# Registro de decisiones de arquitectura (ADR)

Formato: contexto → decisión → alternativas → consecuencias.

## ADR-001 · Monorepo pnpm con API propia (13/11/2026)
* **Contexto:** la especificación pide API propia, servicios por dominio, colas persistentes y contratos tipados compartidos.
* **Decisión:** monorepo pnpm (`apps/web`, `apps/api`, `apps/worker`, `packages/shared`, `packages/connectors`) en TypeScript estricto.
* **Alternativas:** solo Supabase (PostgREST + Edge Functions): menos piezas, pero lógica de dominio repartida en SQL/Deno, peor para colas largas y conectores; Next.js full-stack: acopla UI y API.
* **Consecuencias:** un proceso más que desplegar, a cambio de control total de validación, autorización y trabajos.

## ADR-002 · Supabase solo para Auth + Postgres; datos de negocio vía API
* **Decisión:** el frontend usa Supabase exclusivamente para autenticación. Lecturas/escrituras de negocio pasan por la API.
* **Motivo:** autorización en servidor obligatoria, validación estricta y auditoría con contexto. RLS sigue completa como segunda barrera (y protege el acceso directo a PostgREST con el JWT del usuario).
* **Alternativa descartada:** consultas directas desde el navegador con supabase-js (dependería solo de RLS para todo).

## ADR-003 · La API consulta como el usuario (`SET LOCAL ROLE authenticated`)
* **Decisión:** `withUser()` ejecuta cada transacción con el rol `authenticated` y los claims del JWT; `withService()` (service_role) solo tras comprobación explícita.
* **Motivo:** un bug en un endpoint no puede saltarse RLS. Las comprobaciones de la API usan las mismas funciones SQL que las políticas.
* **Consecuencia:** coste de 2 sentencias extra por transacción (despreciable).

## ADR-004 · RBAC en tablas + funciones `private.*` SECURITY DEFINER
* **Decisión:** permisos como datos (`permissions`, `roles`, `role_permissions`), roles de sistema + personalizados por organización, rol extra por cliente (`client_members.role_id`). Funciones en esquema `private` (no expuesto por la API REST) con `search_path=''`.
* **Alternativas:** claims personalizados en el JWT (Custom Access Token Hook): más rápido pero los cambios de permisos no son inmediatos hasta renovar el token; enum de roles fijo: no extensible.
* **Consecuencia:** revocaciones efectivas al instante; tests garantizan que catálogo SQL y TypeScript coinciden.

## ADR-005 · FK compuestas `(organization_id, id)` y tenant inmutable
* **Decisión:** todas las relaciones de tenant usan FK compuestas y un trigger impide cambiar `organization_id`/`client_id`.
* **Motivo:** garantía estructural de aislamiento incluso para procesos con service_role.

## ADR-006 · Superadministrador fuera del modelo de organización
* **Decisión:** tabla `platform_admins`; acceso total vía las funciones de autorización, siempre auditado, con MFA obligatorio para acciones sensibles.
* **Pendiente (F6):** valorar un modo *break-glass* (acceso a contenido de tenants solo con justificación registrada).

## ADR-007 · Cola persistente con pg-boss
* **Decisión:** pg-boss sobre PostgreSQL para sincronizaciones, IA y publicación.
* **Alternativas:** BullMQ + Redis (otra infraestructura que operar y respaldar); Supabase Queues (pgmq) — viable, pero menos funcionalidades listas (cron, singleton, backoff) en Node.
* **Consecuencia:** una sola base que respaldar; colas transaccionales con los datos.

## ADR-008 · Verificación de JWT por JWKS con fallback HS256
* **Decisión:** la API verifica tokens con las claves públicas del proyecto (JWKS, ES256/RS256). HS256 solo para local/tests o proyectos legados.

## ADR-009 · Monitorización web con proveedor de búsqueda intercambiable (pendiente de elección)
* **Contexto:** Google Custom Search JSON API cierra el 1/1/2027 y Bing Search API se retiró el 11/08/2025.
* **Decisión:** interfaz `SearchProvider`; candidatos: Brave Search API, proveedores de noticias con licencia, RSS/Atom. Elección final en Fase 4 tras comparar cobertura en España y coste.
* **Bloqueo:** requiere decisión comercial de Leo/la agencia.

## ADR-010 · Zod 4 como validador compartido
* **Decisión:** Zod 4 (≥ 4.6.6) en API y web con los mismos esquemas (`packages/shared`). Se migró desde Zod 3 durante la Fase 1 por la vulnerabilidad GHSA-mrhx-c7xc-m3w5 (consumo de memoria con entradas enormes).

## ADR-011 · Registro solo por invitación
* **Decisión:** `enable_signup = false`; los usuarios se crean por invitación (superadmin → admin de organización → equipo). La invitación pendiente se activa al primer inicio de sesión válido; un miembro suspendido nunca se reactiva solo.

## ADR-012 · Tests de RLS sobre PostgreSQL con *shim* de Supabase
* **Decisión:** las pruebas de políticas se ejecutan sobre PostgreSQL ≥ 15 con un shim (`supabase/tests/supabase_shim.sql`) que reproduce roles, `auth.uid()` y privilegios por defecto. Las mismas migraciones se validan además contra el stack real de Supabase (`supabase start` + `supabase db lint`) y con la prueba e2e.
* **Motivo:** CI rápido y sin Docker; la verificación con Supabase real se hace en local/staging.

## ADR-013 · Worker como segundo proceso del paquete API (14/11/2026)
* **Decisión:** `apps/api/src/worker.ts` comparte `src/domain/*` con la API y se despliega como proceso aparte (`start:worker`). Sustituye a la carpeta `apps/worker` prevista en la Fase 0.
* **Motivo:** las reglas de flujo (transiciones, aprobación, publicación) deben ser idénticas en API y worker; un solo paquete evita duplicarlas o crear otro paquete compartido con dependencias de BD.
* **Consecuencia:** un único artefacto de build (esbuild, `dist/server.js` y `dist/worker.js`); escalan por separado.

## ADR-014 · Outbox en tablas + avisos pg-boss tras el commit
* **Decisión:** el estado de sincronizaciones y publicaciones vive en tablas propias; pg-boss solo transporta avisos `{id}`. Un barrido periódico re-encola lo pendiente.
* **Alternativa descartada:** usar pg-boss como fuente de verdad (`send` dentro de la transacción). Acopla el esquema de la cola al de negocio y complica la auditoría.
* **Consecuencia:** tolerante a pérdidas de mensajes y a caídas; manejadores idempotentes.

## ADR-015 · La aprobación se ata al hash SHA-256 del texto exacto
* **Decisión:** el aprobador envía el `contentHash` del texto que ve (calculado en su navegador). La API lo compara con el último borrador y la BD vuelve a comprobarlo al crear el trabajo de publicación.
* **Consecuencia:** cualquier edición posterior (o concurrente) invalida la aprobación; no se publica un texto distinto del aprobado.

## ADR-016 · Aprobar = autorizar la publicación
* **Decisión:** en el MVP, aprobar (`responses.approve`) encola la publicación automáticamente. `responses.publish` solo se exige para reintentar manualmente (o `responses.approve`). No se permite aprobar ni publicar por lotes.
* **Pendiente de validar con Leo:** si se quiere separación estricta de funciones (quien redacta no puede aprobar). Hoy el permiso lo decide el rol; una persona con ambos permisos podría hacer las dos cosas.

## ADR-017 · Triaje determinista provisional
* **Decisión:** hasta la IA (F3), prioridad y banderas de riesgo se calculan con reglas explícitas (valoración ≤ 2 → alta; palabras de ámbito legal, sanitario, seguridad o discriminación → crítica + revisión especializada; textos que dan instrucciones al sistema → marca `prompt_injection`).
* **Consecuencia:** explicable y probado; se sustituirá o combinará con la clasificación IA en F3. La prioridad nunca baja automáticamente al editarse una reseña.

## ADR-018 · Simulador con estado remoto en el esquema `private`
* **Decisión:** el proveedor simulado guarda sus reseñas ficticias y respuestas en `private.simulator_*`, de modo que el worker y la API ven el mismo «remoto» y se pueden probar ambigüedades y duplicados de verdad. Bloqueado en `NODE_ENV=production`; todos sus datos llevan `is_simulated = true` y la etiqueta «Simulado» en la interfaz.

## ADR-019 · Cliente propio de la Responses API y adaptador `AiProvider`
* **Decisión:** una sola llamada HTTP (`POST /v1/responses`) con Structured Outputs estricto, sin herramientas y con `store: false`, detrás de la interfaz `AiProvider`. Sin SDK.
* **Motivo:** superficie mínima, errores clasificados por nosotros (`auth`, `rate_limited`, `transient`, `refusal`, `incomplete`, `invalid_output`) y pruebas sin red (proveedor simulado o `fetch` inyectado).
* **Consecuencia:** cambiar de proveedor = otra implementación de `AiProvider`.

## ADR-020 · Presupuesto con reserva previa por organización
* **Decisión:** cada llamada inserta antes una fila `ai_generations` en estado `running` con el coste estimado, bajo `pg_advisory_xact_lock` por organización; el gasto del mes suma estimaciones en curso y costes reales cerrados. Con `hard_stop` no se llama al modelo si se superaría el límite y se registra la fila como `blocked`.
* **Consecuencia:** dos peticiones simultáneas no pueden superar el presupuesto; queda traza de cada bloqueo.

## ADR-021 · Hasta el DPA, IA real solo con datos ficticios
* **Decisión:** `platform_settings.ai_real_data_allowed` (por defecto `false`). Con un proveedor externo, las interacciones con `is_simulated = false` no se clasifican (`skipped`) ni se pueden usar para generar borradores (409).
* **Consecuencia:** se puede probar con OpenAI real sin enviar datos personales de clientes. Activarlo requiere el DPA firmado y una decisión explícita de Leo.

## ADR-022 · Las reglas deterministas mandan sobre la IA
* **Decisión:** la clasificación de la IA solo puede **subir** prioridad y añadir riesgos (nunca quitarlos); valoración ≤ 2 → al menos alta; riesgo sanitario, alimentario, legal, de seguridad o discriminación → crítica y revisión especializada. Los borradores pasan validaciones fijas (enlaces/emails/teléfonos no verificados, expresiones prohibidas, longitud, repetición) independientemente de lo que «diga» el modelo.
* **Consecuencia:** el triaje de la Fase 2 (ADR-017) se mantiene como suelo; la IA lo enriquece.

