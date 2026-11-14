# Seguridad y protección de datos

## Modelo de amenazas (resumen)

| Amenaza | Control | Estado |
|---|---|---|
| Acceso a datos de otra organización | RLS en todas las tablas + autorización en API con las mismas funciones SQL + FK compuestas + `organization_id` inmutable | ✅ F1, probado (`apps/api/test/rls`) |
| Escalada de privilegios dentro de la organización | `members.manage` requerido; roles de sistema no editables; permisos `platform.*` no asignables a roles de organización; no se puede quitar el último admin | ✅ F1, probado |
| Robo de sesión / credenciales | Supabase Auth, contraseñas ≥ 12, MFA TOTP, `ENFORCE_ADMIN_MFA` (aal2) para acciones sensibles, refresh token rotation | ✅ F1 (MFA e2e pendiente de entorno Supabase) |
| Tokens JWT manipulados | Verificación por JWKS (ES256/RS256) o HS256 local; `alg=none` rechazado; audiencia `authenticated`, issuer | ✅ F1, probado |
| CSRF | API con `Authorization: Bearer`, sin cookies de sesión; CORS con lista blanca | ✅ F1 |
| XSS | React escapa por defecto; sin `dangerouslySetInnerHTML`; URLs validadas `^https?://`; enlaces externos `rel="noopener noreferrer nofollow"`; CSP en el hosting estático (ver DEPLOYMENT) | ✅ F1 / CSP al desplegar |
| Inyección SQL | Consultas parametrizadas (`postgres` tagged templates); identificadores de orden por lista blanca; `LIKE` escapado | ✅ F1, probado |
| Mass assignment | Esquemas Zod `.strict()`; columnas actualizables limitadas por `GRANT UPDATE (col, …)` | ✅ F1, probado |
| SSRF (monitorización web, webhooks) | Solo http/https, bloqueo de IPs privadas/link-local tras resolución DNS, límites de tamaño/tiempo, sin redirecciones a hosts internos | 📐 diseño F4 |
| Prompt injection | Contenido externo tratado como dato; la IA no tiene herramientas de publicación; salida estructurada validada; ver `AI_DESIGN.md` | 📐 diseño F3 |
| Publicación no autorizada / duplicada | Máquina de estados en backend y BD (trigger), aprobación ligada al hash SHA-256 del texto (comprobada en API y en BD), un solo trabajo vivo por interacción (índice único), idempotencyKey, consulta remota antes de reintentar, interruptor global y por organización, sin aprobación por lotes | ✅ F2, probado (`test/api/inbox.test.ts`) |
| Saltarse el flujo con la API REST de Supabase | `authenticated` solo tiene SELECT en tablas de flujo; las escrituras pasan por API/worker | ✅ F2, probado (RLS) |
| Uso de datos simulados como reales | `is_simulated` solo con `provider = 'simulator'` (CHECK), simulador bloqueado en producción, etiqueta «Simulado» en toda la interfaz | ✅ F2 |
| Fuga de secretos en logs | Redacción de `authorization`/`cookie` en Pino; `private.redact()` en auditoría; errores sin detalles internos | ✅ F1, probado |
| Tokens OAuth expuestos | Supabase Vault en esquema no expuesto; solo `service_role` | 📐 diseño F4 |
| Abuso / fuerza bruta | Rate limit por usuario/IP en API (`@fastify/rate-limit`); límites de Supabase Auth | ✅ F1 |
| Webhooks falsificados o repetidos | HMAC `X-Hub-Signature-256` en tiempo constante, tabla `webhook_events` con `UNIQUE (provider, event_id)` | 📐 diseño F4 |

## Autenticación y sesiones

* Proveedor: Supabase Auth. Registro público **desactivado**; alta solo por invitación (`/auth/v1/invite`) de un superadministrador o administrador de organización.
* MFA: TOTP. Con `organizations.require_admin_mfa = true` (por defecto) y `ENFORCE_ADMIN_MFA=true` (obligatorio en producción), las acciones de gestión de miembros, roles, configuración de organización y alta de organizaciones exigen `aal2`.
* Suspender a un miembro o a una organización revoca el acceso a datos **inmediatamente** (las políticas comprueban `status`), aunque su JWT siga vigente.
* Duración de JWT: 1 h, con rotación de refresh tokens.

## Autorización

Ver `DATA_MODEL.md → Modelo de permisos efectivo`. Reglas:

1. La API comprueba permisos explícitamente antes de cada operación.
2. La BD vuelve a comprobar con RLS (`withUser`).
3. `withService` solo tras comprobación explícita, y con el actor propagado a la auditoría.
4. Respuestas `404` (no `403`) para recursos de otros tenants, para no revelar su existencia.

## Secretos

* Solo en variables de entorno del backend/worker o en el gestor de secretos del proveedor de hosting. Nunca en el repositorio (`.gitignore` excluye `.env*`), nunca en el frontend (solo `VITE_SUPABASE_ANON_KEY`, que es pública por diseño y está limitada por RLS).
* `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, secretos de apps de Google/Meta: solo API/worker.
* Rotación: documentada en `DEPLOYMENT.md`.

## Privacidad y RGPD

* **Roles:** la agencia (organización) es responsable del tratamiento respecto a los datos de sus clientes; la plataforma actúa como **encargado** (contrato de encargo art. 28 RGPD a firmar con cada organización). OpenAI, Supabase y el hosting son subencargados: requieren DPA y, si hay transferencias fuera del EEE, cláusulas contractuales tipo / marco de privacidad UE-EE. UU.
* **Finalidad:** gestionar la reputación digital del cliente (lectura de reseñas/comentarios públicos o autorizados y respuesta supervisada).
* **Base jurídica:** interés legítimo del cliente en responder a opiniones públicas sobre su negocio (art. 6.1.f), con evaluación de ponderación documentada por la agencia.
* **Minimización:** del autor solo se guarda el nombre visible y un identificador seudonimizado (HMAC-SHA256 con `AUTHOR_REF_PEPPER`, F2); a la IA se envía el texto de la interacción **sin** nombre ni identificadores del autor ni otros datos personales innecesarios Desde F3 se enmascaran emails y teléfonos detectados, se eliminan caracteres invisibles y el proveedor no almacena las respuestas (`store: false`). **Hasta firmar el DPA, la IA real solo recibe reseñas ficticias** (ADR-021).
* **Conservación:** tabla de plazos en `DATA_MODEL.md`.
* **Derechos de los interesados:** búsqueda por autor/URL y borrado/anonimización de sus interacciones mediante un procedimiento administrativo auditado (F5). Las reseñas siguen existiendo en la plataforma de origen; borramos nuestra copia.
* **Datos sensibles:** reseñas sobre salud (clínicas) pueden contener datos de categoría especial (art. 9). Se marcan como riesgo, no se envían a la IA sin necesidad y siempre requieren revisión humana.
* **Ubicación:** proyectos Supabase en región UE (Fráncfort o similar).

## Interruptor de emergencia

* `platform_settings.publishing_kill_switch` (superadmin) y `organizations.publishing_paused` (admin de organización). El worker los consulta justo antes de cada publicación: si están activos, el trabajo queda en espera (no se pierde ni se marca como fallido) y se reanuda al desactivarlos. Cambiarlos queda auditado. ✅ F2, probado.

## Gestión de vulnerabilidades

* Dependencias fijadas por lockfile; Dependabot semanal (`.github/dependabot.yml`); `pnpm audit --prod` en CI.
* Revisión de migraciones obligatoria en PR (RLS, grants, `security definer` con `search_path`). Un test verifica que todas las tablas tienen RLS y que ninguna función `SECURITY DEFINER` carece de `search_path`.
