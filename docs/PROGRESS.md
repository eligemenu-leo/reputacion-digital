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
| Generación de respuestas con IA | ✅ | Fase 3 |
| Dockerfile | ⏳ | al elegir hosting |

**Errores encontrados y corregidos durante la verificación:**
1. El build de producción de la API (`tsc` con NodeNext) no funcionaba desde la Fase 1 y la CI no lo comprobaba → bundle con esbuild y paso de build de la API en CI.
2. El buscador con retardo de la bandeja restauraba filtros que el usuario acababa de quitar (parámetros de URL desactualizados) → se usa siempre el estado más reciente.
3. El resumen de la última sincronización devolvía claves `snake_case` (JSON sin transformar) → objeto JSON construido con claves explícitas.
4. Los enlaces nuevos del panel hacían ambiguos los selectores del e2e de la Fase 1 → selectores exactos.

**Decisiones a validar por Leo:** separación de funciones redactor/aprobador (ADR-016) y si las aprobaciones deben exigir MFA (hoy no lo exigen; sí la gestión de miembros).

## Fase 3 — IA, primer bloque ✅ (14/11/2026)

| Funcionalidad | Estado | Verificación |
|---|---|---|
| Migración: generaciones de IA, presupuestos, estado del análisis, guarda del DPA | ✅ | PG 16 (shim); 3 pruebas de invariantes |
| Personalidad de marca versionada (API + pestaña en la ficha del cliente) | ✅ | pruebas de permisos y versiones inmutables |
| Clasificación automática en el worker (sentimiento, categoría, temas, prioridad, riesgos) con reglas deterministas encima | ✅ | pruebas de flujo con proveedor simulado |
| «Generar con IA» y variantes (otra versión, más breve, más cercana, más formal) con la marca vigente | ✅ | pruebas de flujo |
| Defensas: contenido delimitado y escapado, sin autor, emails/teléfonos enmascarados, sin herramientas, Unicode invisible, validación de salida y de borradores | ✅ | pruebas unitarias y de flujo |
| Presupuesto mensual con reserva previa y corte; registro de coste por generación | ✅ | pruebas de flujo |
| Guarda de datos reales hasta el DPA | ✅ | pruebas de flujo |
| Interfaz: análisis en la ficha y sentimiento en la bandeja, avisos del borrador de IA (también para quien aprueba), estado y presupuesto en Configuración | ✅ | typecheck + e2e `phase3-smoke.mjs` |
| Prueba real con OpenAI (reseñas ficticias) | ✅ | e2e en el Mac de Leo: 12 reseñas clasificadas en 9 s (gpt-5.4-mini), borrador y variante (gpt-5.4), 14 generaciones, 0,0183 USD; `supabase db lint` sin errores |
| Métricas observadas por cliente y periodo con comparación y temas | ✅ | pruebas de flujo (`reports.test.ts`) |
| Informes con resumen de IA validado contra las cifras y hallazgos con ≥ 3 reseñas | ✅ | pruebas de flujo + unitarias |
| Página de Informes (métricas, informe guardado, enlaces a las reseñas de respaldo) | ✅ | e2e `phase3-smoke.mjs` (paso 6) |
| Prompt de redacción v2 (concordancia verbal) | ✅ | tras la prueba real |

**Errores encontrados y corregidos durante la verificación:**
1. El trigger `updated_at` impedía simular avisos antiguos en las pruebas del barrido de análisis → el barrido recibe el umbral como parámetro (como en publicaciones).
2. El rango de caracteres invisibles se había guardado como caracteres literales (ESLint `no-irregular-whitespace`) → reescrito con secuencias de escape.
3. Prueba real (bloque 2, Mac, gpt-5.4): la página Informes se quedaba en blanco (lectura de `insights.data` antes de cargar), al resumen no le llegaban ejemplos si ningún tema tenía 3 menciones y el modelo redactó porcentajes como recuentos («42 de positivo»). Corregido con `summary.v2`, ejemplos de contexto y la regla de validación «una cifra que solo existe como `*_pct` lleva %». Segunda ronda: e2e completo OK, informe `ready` con 2 hallazgos respaldados por 3 reseñas cada uno, coste 0,0314 $.
4. Ajustes de esa segunda ronda: «negativas o mixtas», ningún hallazgo sobre el sector del negocio, «Más breve» ≤ 85 % del borrador actual, singular «1 estrella».

## Fase 4 — Integraciones, bloque 1: Google Business Profile 🟡 (15/11/2026)

Implementado y probado contra un servidor falso de Google; **sin acceso real todavía** (lo bloquea Google, no el código).

| Entregable | Estado | Verificación |
|---|---|---|
| Conector `GoogleBusinessConnector` (OAuth PKCE, cuentas, ubicaciones con aptitud, reseñas, responder, verificar, revocar) | ✅ | 10 pruebas unitarias contra `FakeGoogleApi` |
| Tokens sellados (AES-256-GCM, ADR-024) en `private.*`, sin acceso de usuarios | ✅ | pruebas de RLS y de sellado |
| Flujo OAuth con state de un solo uso y elección de fichas por quien autorizó | ✅ | `test/api/google.test.ts` (19 pruebas) |
| Una fuente por ficha; fichas no verificadas en solo lectura (ADR-025) | ✅ | pruebas de flujo |
| Refresco automático, credencial revocada visible, revocación al desconectar, limpieza de autorizaciones abandonadas | ✅ | pruebas de flujo |
| Pantalla Fuentes: tarjeta de Google con estado real, URI de redirección, selección de fichas, «Solo lectura», desconectar | ✅ | typecheck + lint; revisión visual pendiente en el Mac |
| Conexión con una ficha real de Google | 🔒 | cliente OAuth de Google Cloud + aprobación de acceso a la API |
| Notificaciones Pub/Sub de reseñas nuevas | ⏳ | siguiente iteración (hoy: sondeo periódico) |

## Pendiente y bloqueado

| Elemento | Estado | Motivo |
|---|---|---|
| IA con datos reales de clientes | 🔒 | DPA con OpenAI (la clave ya está configurada en local) |
| Google Business Profile | 🔒 | código listo; falta cliente OAuth y aprobación de acceso de Google (pasos en `INTEGRATIONS.md`) |
| Facebook / Instagram | 🔒 | app de Meta + App Review |
| Monitorización web | 🔒 | elección/contrato de proveedor (ADR-009) |
| Staging / producción | 🔒 | aprobación de coste de proyectos Supabase y hosting |
| Email transaccional en producción | 🔒 | proveedor SMTP |
| Rendimiento (LCP, p95) y auditoría WCAG | ⏳ | Fase 6 |
