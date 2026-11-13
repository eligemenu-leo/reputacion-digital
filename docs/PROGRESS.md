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
| Dockerfile de API/worker | ⏳ | F2 |

**Errores encontrados y corregidos durante la verificación:**
1. `INSERT … RETURNING` de clientes fallaba por RLS (la política de SELECT consultaba la fila aún no visible) → nueva función `has_client_permission_in(org, client, perm)`.
2. Las invitaciones de Supabase ignoraban `redirect_to` en el cuerpo → se envía en la query string.
3. El enlace de invitación (tokens en el fragmento) no creaba sesión con el flujo PKCE → la página de callback consume el fragmento y lo elimina del historial.
4. Los usuarios invitados quedaban en estado `invited` para siempre → se activan al primer inicio de sesión válido (nunca si están suspendidos).
5. Zod 3 con vulnerabilidad alta (GHSA-mrhx-c7xc-m3w5) → migrado a Zod 4.6.

## Pendiente y bloqueado

| Elemento | Estado | Motivo |
|---|---|---|
| Fase 2: bandeja, interacciones, estados, borradores, aprobaciones, simulador, worker | ⏳ | siguiente bloque |
| Fase 3: IA | 🔒 | clave de OpenAI + DPA |
| Google Business Profile | 🔒 | acceso a la API (solicitud a Google) |
| Facebook / Instagram | 🔒 | app de Meta + App Review |
| Monitorización web | 🔒 | elección/contrato de proveedor (ADR-009) |
| Staging / producción | 🔒 | aprobación de coste de proyectos Supabase y hosting |
| Email transaccional en producción | 🔒 | proveedor SMTP |
| Rendimiento (LCP, p95) y auditoría WCAG | ⏳ | Fase 6 |
