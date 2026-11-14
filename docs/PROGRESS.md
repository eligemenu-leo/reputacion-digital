# Progreso

Leyenda: ✅ completado y verificado · 🟡 parcial · ⏳ pendiente · 🔒 bloqueado por dependencia externa

## Fase 0 — Análisis y arquitectura ✅ (13/11/2026)

| Entregable | Estado | Documento |
|---|---|---|
| Revisión de requisitos, contradicciones y dependencias | ✅ | `PRODUCT_SPEC.md` |
| Verificación de documentación vigente de proveedores | ✅ | `INTEGRATIONS.md` |
| Arquitectura y estructura de carpetas | ✅ | `ARCHITECTURE.md` |
| Esquema PostgreSQL (F1 implementado, resto diseñado) | ✅ | `DATA_MODEL.md` |
| Modelo de permisos y RLS | ✅ | `DATA_MODEL.md`, `SECURITY.md` |
| Contrato común de conectores | ✅ | `packages/connectors/src/contract.ts` |
| Estrategia de IA | ✅ | `AI_DESIGN.md` |
| Plan de pruebas | ✅ | `TEST_PLAN.md` |
| Decisiones | ✅ | `DECISIONS.md` |

## Fase 1 — Fundamentos ✅ (13/11/2026)

| Funcionalidad | Estado | Verificación |
|---|---|---|
| Monorepo pnpm, TypeScript estricto, ESLint, Prettier, CI (GitHub Actions), Dependabot | ✅ | lint/format/typecheck en verde |
| Migraciones: identidad, organizaciones, RBAC, miembros, clientes, ubicaciones, asignaciones, marca versionada, ajustes, auditoría | ✅ | aplicadas en PostgreSQL 16 (shim) y en Supabase local (PG 17); `supabase db lint` sin avisos |
| RLS en todas las tablas + funciones de autorización | ✅ | 28 pruebas RLS |
| API: `/me`, organizaciones, miembros (invitar, rol, suspender), roles, clientes (CRUD + búsqueda/paginación), ubicaciones, asignaciones, resumen, auditoría | ✅ | 22 pruebas de integración |
| Autenticación: login, recuperación, nueva contraseña, aceptación de invitación, MFA TOTP, exigencia `aal2` | ✅ | e2e real con Supabase Auth + Mailpit |
| Interfaz: layout, panel, clientes, ficha, ubicaciones, equipo, usuarios, configuración, auditoría, admin de plataforma, mi cuenta, modo claro/oscuro, móvil | ✅ | e2e (10 pasos) + capturas |
| Contratos compartidos: permisos, esquemas, errores, máquina de estados | ✅ | 12 pruebas unitarias |
| Utilidades de deduplicación | ✅ | 3 pruebas |
| Script de bootstrap de superadministrador | ✅ | usado en e2e |
| Roles personalizados (UI) | ⏳ | soportado en BD/RLS; UI en F2 |
| Dockerfile de API/worker | ⏳ | al elegir hosting |

**Errores encontrados y corregidos durante la verificación:**
1. `INSERT … RETURNING` de clientes fallaba por RLS (la política de SELECT consultaba la fila aún no visible) → nueva función `has_client_permission_in(org, client, perm)`.
2. Las invitaciones de Supabase ignoraban `redirect_to` en el cuerpo → se envía en la query string.
3. El enlace de invitación (tokens en el fragmento) no creaba sesión con el flujo PKCE → la página de callback consume el fragmento y lo elimina del historial.
4. Los usuarios invitados quedaban en estado `invited` para siempre → se activan al primer inicio de sesión válido (nunca si están suspendidos).
5. Zod 3 con vulnerabilidad alta (GHSA-mrhx-c7xc-m3w5) → migrado a Zod 4.6.

## Fase 2 — Operativa ✅ (14/11/2026)

| Funcionalidad | Estado | Verificación |
|---|---|---|
| Migración: fuentes, sincronizaciones, interacciones normalizadas, versiones, borradores, aprobaciones, publicaciones, intentos, recibos, historial | ✅ | PG 16 (shim) + Supabase local (PG 17); `supabase db lint` sin avisos |
| Invariantes en BD: transiciones, publicación solo con la última aprobación del texto exacto, una publicación viva, append-only, usuarios solo lectura | ✅ | 6 pruebas RLS nuevas + pruebas de flujo |
| Conector simulador con modos de fallo (ambiguo, límite, error, credenciales) | ✅ | 4 pruebas unitarias + flujo |
| Worker pg-boss: sincronización incremental con deduplicación y versiones, publicación idempotente con consulta previa, interruptores, barrido de recuperación | ✅ | 23 pruebas de flujo + e2e con worker real |
| API: bandeja (filtros, búsqueda, orden, paginación), detalle, asignación, prioridad, acciones, lotes seguros, borradores, solicitud y decisión de aprobación, reintento, fuentes y ejecuciones, resumen real | ✅ | pruebas de integración |
| Triaje provisional por reglas (prioridad, riesgos, revisión especializada) | ✅ | 3 pruebas unitarias |
| Interfaz: bandeja con lotes, ficha con historial y editor, aprobaciones (móvil), fuentes con modos de prueba, panel con métricas reales | ✅ | e2e (9 pasos) + capturas |
| Build de producción de API y worker (esbuild) y en CI | ✅ | `pnpm --filter @rep/api build` |
| Generación de respuestas con IA | 🔒 | Fase 3 (botón visible y desactivado) |
| Dockerfile | ⏳ | al elegir hosting |

**Errores encontrados y corregidos durante la verificación:**
1. El build de producción de la API (`tsc` con NodeNext) no funcionaba desde la Fase 1 y la CI no lo comprobaba → bundle con esbuild y paso de build de la API en CI.
2. El buscador con retardo de la bandeja restauraba filtros que el usuario acababa de quitar (parámetros de URL desactualizados) → se usa siempre el estado más reciente.
3. El resumen de la última sincronización devolvía claves `snake_case` (JSON sin transformar) → objeto JSON construido con claves explícitas.
4. Los enlaces nuevos del panel hacían ambiguos los selectores del e2e de la Fase 1 → selectores exactos.

**Decisiones a validar por Leo:** separación de funciones redactor/aprobador (ADR-016) y si las aprobaciones deben exigir MFA (hoy no lo exigen; sí la gestión de miembros).

## Pendiente y bloqueado

| Elemento | Estado | Motivo |
|---|---|---|
| Fase 3: IA | 🔒 | clave de OpenAI + DPA |
| Google Business Profile | 🔒 | acceso a la API (solicitud a Google) |
| Facebook / Instagram | 🔒 | app de Meta + App Review |
| Monitorización web | 🔒 | elección/contrato de proveedor (ADR-009) |
| Staging / producción | 🔒 | aprobación de coste de proyectos Supabase y hosting |
| Email transaccional en producción | 🔒 | proveedor SMTP |
| Rendimiento (LCP, p95) y auditoría WCAG | ⏳ | Fase 6 |
