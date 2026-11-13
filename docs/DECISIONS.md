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
