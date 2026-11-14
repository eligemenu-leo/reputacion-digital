# Integraciones con proveedores

> Documentación verificada el **13/11/2026** (Meta, de nuevo, el 14/11/2026) contra la documentación oficial. Antes de implementar cada conector (Fase 4) se debe volver a verificar, porque los proveedores cambian versiones y permisos con frecuencia.

## Estado

| Proveedor | Estado | Bloqueo externo |
|---|---|---|
| Google Business Profile | 🟡 **Implementado, pendiente de acceso** (F4 · bloque 1, probado contra un Google falso) | Cliente OAuth en Google Cloud + aprobación de acceso a las Business Profile APIs (cuota 0 QPM hasta aprobación) |
| Facebook (Páginas) | 🟡 **Implementado, pendiente de app** (F4 · bloque 2, probado contra un Meta falso) | App de Meta; para cuentas sin rol en la app: verificación de empresa + App Review |
| Instagram (cuentas profesionales) | 🟡 **Implementado, pendiente de app** (F4 · bloque 2, misma app y mismo inicio de sesión) | Igual que Facebook |
| Monitorización web | 🔒 **Bloqueado** | Elegir y contratar proveedor de búsqueda (ver abajo) |
| Simulador | ✅ Fase 2 | — (solo dev/test, datos marcados como ficticios) |

Ninguna integración se muestra como activa en la interfaz hasta tener credenciales válidas y permisos verificados.

## Contrato común

`packages/connectors/src/contract.ts` define `ProviderConnector`:

`connect · completeConnect · disconnect · validateCredentials · refreshCredentials · listAccounts · listLocations · fetchInteractions · fetchInteraction · publishReply · getPublicationStatus · handleWebhook · getCapabilities · getHealthStatus`

* Todas devuelven `Result<T>`; nunca lanzan por errores esperados del proveedor.
* Operación no soportada → `{ ok:false, error:{ kind:'not_supported' } }`.
* Errores clasificados (`credentials_expired`, `insufficient_permissions`, `rate_limited`, `transient`, `ambiguous`…) para que el motor decida: reintentar con backoff, marcar la cuenta como «Credenciales caducadas», o consultar estado remoto antes de reintentar.
* `getCapabilities()` distingue **soportado por el proveedor** de **concedido a esta cuenta** (scopes reales).
* Los conectores no conocen la base de datos ni los tenants.
* Deduplicación: `(provider, connected_account_id, external_id)`; ediciones detectadas con `contentHash()`; URLs web normalizadas con `normalizeUrl()`.

## Google Business Profile

**Verificado:**
* Reseñas en la API v4: `accounts.locations.reviews` (`list`, `get`, `batchGetReviews`, `updateReply`, `deleteReply`). Novedades 2026: `ReviewReplyState` (estado de moderación de la respuesta, abr-2026), `PolicyViolation` (jul-2026), `reviewReplyUrl` (jul-2026), medios en reseñas (abr-2026). Fuente: <https://developers.google.com/my-business/content/latest-updates>
* Acceso: formulario de contacto «Application for Basic API Access» con el número de proyecto de Google Cloud. Requisitos: perfil verificado y activo **60+ días**, web propia del negocio, email que sea propietario/gestor del perfil. Cuota 0 QPM = no aprobado; 300 QPM = aprobado. Fuente: <https://developers.google.com/my-business/content/prereqs>
* Notificaciones de nuevas reseñas mediante Cloud Pub/Sub (configuración en la cuenta).

**Diseño del conector:**
* OAuth 2.0 (scope `https://www.googleapis.com/auth/business.manage`), PKCE, `access_type=offline`, `prompt=consent` para obtener refresh token.
* Separar **consulta** (Account Management + Business Information para cuentas/ubicaciones), **sincronización** (reviews) y **publicación** (`updateReply`).
* Comprobar que cada ubicación pertenece a una cuenta autorizada y está verificada antes de permitir responder (`canReply`).
* Tras `updateReply`, verificar con `reviews.get` y leer `ReviewReplyState`: la publicación no se da por completada hasta que la respuesta aparece (y se refleja si está pendiente de moderación o rechazada por política).
* `updateReply` sobrescribe la respuesta existente: es idempotente por naturaleza, pero se compara el texto remoto antes de reintentar.

**Dependencias de Leo/la agencia:** proyecto de Google Cloud, pantalla de consentimiento OAuth (verificación de Google si el scope es sensible), solicitud de acceso a la API, al menos un perfil verificado 60+ días para probar.

### Implementación (Fase 4 · bloque 1, 15/11/2026)

Endpoints reverificados el 14/11/2026 (referencia actualizada el 02/11/2026):

| Uso | Llamada |
|---|---|
| Cuentas | `GET mybusinessaccountmanagement.googleapis.com/v1/accounts` (pageSize ≤ 20) |
| Ubicaciones | `GET mybusinessbusinessinformation.googleapis.com/v1/{accounts/*}/locations?readMask=name,title,storefrontAddress,metadata` (pageSize ≤ 100) |
| ¿Puede responder? | `GET mybusinessverifications.googleapis.com/v1/{locations/*}/VoiceOfMerchantState` → `hasVoiceOfMerchant` |
| Reseñas | `GET mybusiness.googleapis.com/v4/{accounts/*}/{locations/*}/reviews?orderBy=updateTime desc` (pageSize ≤ 50) |
| Responder | `PUT …/reviews/{id}/reply` `{ comment }` → `ReviewReply` con `reviewReplyState` (`PENDING`/`APPROVED`/`REJECTED`) y `policyViolation` |
| Verificar | `GET …/reviews/{id}` y comparación del texto (el `get` no devuelve `reviewReplyState`) |

* **Código:** `packages/connectors/src/google.ts` (conector), `apps/api/src/routes/google.ts` (OAuth y selección), `apps/api/src/domain/credentials.ts` y `connection-lifecycle.ts` (sellado, refresco, revocación).
* **Flujo:** «Conectar Google» → Google → `/v1/oauth/google/callback` (state de un solo uso, 10 min, PKCE S256) → el mismo usuario elige las fichas → una fuente por ficha y primera sincronización.
* **Una fuente por ubicación:** `external_account_id = accounts/A/locations/L`; varias fuentes pueden compartir la misma autorización (`credential_id`).
* **Fichas no verificadas:** se conectan en **solo lectura** (sin `publish_reply` en `capabilities`); el motor de publicación no llama a Google y deja el motivo («La ficha no está verificada», «Google está revisando la ficha»…).
* **Sincronización incremental:** orden `updateTime desc`, se detiene al llegar a `last_success_sync_at − 15 min`. Autores anónimos sin nombre. Sin `authorExternalId` (Google no lo da).
* **Publicación:** `PUT` crea o sustituye (no puede duplicar). Un corte de red o un 5xx tras escribir es `ambiguous` y el motor consulta la reseña antes de reintentar. `PENDING` = aceptada por Google, en moderación (`provider_state = pending_moderation`); `REJECTED` = error no reintentable con el motivo de política.
* **Errores:** 401 → credenciales caducadas; 403 → acceso insuficiente (también sin aprobación de acceso); 429 → límite con `Retry-After`; `invalid_grant` al refrescar → «Credenciales caducadas, vuelve a conectar». Los mensajes se recortan y se limpian de tokens.
* **Desconectar:** si era la última fuente con esa autorización, se borra la credencial y se revoca en `oauth2.googleapis.com/revoke`. Las autorizaciones abandonadas (sin fichas elegidas) se revocan a la hora.
* **No implementado todavía:** notificaciones Pub/Sub (se sincroniza por sondeo), `deleteReply`, `batchGetReviews`.
* **Pruebas:** `packages/connectors/src/google.test.ts` y `apps/api/test/api/google.test.ts` contra `FakeGoogleApi` (`@rep/connectors/testing`), un servidor falso que nunca contacta con Google.

### Cómo obtener el acceso (lo hace Leo)

1. Google Cloud Console → crear proyecto (p. ej. «reputacion-digital»). Anotar el **número de proyecto**.
2. Solicitar acceso con el formulario «Application for Basic API Access» (enlazado desde <https://developers.google.com/my-business/content/prereqs>): email propietario o gestor de una ficha verificada con más de 60 días y web propia. La respuesta suele tardar días o semanas.
3. Habilitar en «APIs y servicios»: My Business Account Management API, My Business Business Information API, My Business Verifications API y Google My Business API.
4. Pantalla de consentimiento OAuth: tipo «Externo», scope `…/auth/business.manage`, añadir como usuarios de prueba los emails que vayan a conectar fichas mientras la app no esté verificada.
5. Credenciales → «ID de cliente de OAuth» tipo **Aplicación web** con el URI de redirección que muestra la pantalla Fuentes (en local: `http://localhost:8787/v1/oauth/google/callback`).
6. Poner `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` y `CREDENTIALS_ENCRYPTION_KEYS` en `apps/api/.env` (nunca en el chat ni en el repositorio) y reiniciar API y worker.

## Meta — Facebook (Páginas) e Instagram profesional

**Verificado el 14/11/2026** en developers.facebook.com:
* Versión vigente de Graph API: **v26.0** (publicada 29/07/2026); v25.0 caduca 29/07/2028. Fuente: <https://developers.facebook.com/docs/graph-api/changelog/versions>
* Facebook Login: diálogo `https://www.facebook.com/v26.0/dialog/oauth` (`client_id`, `redirect_uri`, `state`, `scope`, `response_type=code`); canje en `GET /oauth/access_token`; token de larga duración con `grant_type=fb_exchange_token` (≈ 60 días). `GET /me/accounts` devuelve un token por página **sin caducidad fija** (Meta puede invalidarlo si el usuario cambia la contraseña, pierde el rol o quita la app). No hay PKCE documentado para este flujo.
* Facebook: leer `GET /{post-id}/comments` (`filter=toplevel`, `order`); responder como página `POST /{comment-id}/comments` con `pages_manage_engagement` y la tarea `MODERATE`. Leer el feed requiere `pages_read_engagement` + `pages_read_user_content` y una tarea `MODERATE`, `MANAGE` o `CREATE_CONTENT`.
* Instagram (vía Facebook Login, host `graph.facebook.com`): `GET /{ig-user-id}/media`, `GET /{media-id}/comments` (máx. 50 por página, sin filtro por fecha), responder `POST /{comment-id}/replies`. Permisos `instagram_basic`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`; si el rol en la página viene de un Business Manager, además `ads_read` o `ads_management`. Solo se responde a comentarios de primer nivel, no ocultos y fuera de directos.
* Webhooks: verificación `GET` con `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; avisos `POST` firmados con `X-Hub-Signature-256: sha256=HMAC(app secret, cuerpo)`. Meta reintenta hasta 36 h y agrupa hasta 1000 cambios. La página se suscribe con `POST /{page-id}/subscribed_apps?subscribed_fields=feed` (`pages_manage_metadata`).

### Implementación (Fase 4 · bloque 2, 16/11/2026)

* `packages/connectors/src/meta.ts`: `MetaGraph` (inicio de sesión, páginas, permisos concedidos, revocación, suscripción de webhooks; todas las llamadas con `appsecret_proof` y el token en la cabecera, nunca en la URL), `FacebookPageConnector` e `InstagramBusinessConnector` (contrato común), `verifyMetaSignature`, `metaWebhookChallenge`, `parseMetaWebhook` y `mapMetaError` (190 → credenciales caducadas, 4/17/32/613 → límite, 10/200-299 → permisos, 1/2/5xx → temporal o **ambiguo** si era una escritura; los tokens `EAA…` se borran de los mensajes).
* Sincronización: en cada pasada se revisan las **25 publicaciones más recientes** (`META_POSTS_PER_SYNC`, máx. 50), una por página del cursor, con hasta 500 comentarios de primer nivel cada una. Los comentarios de la propia página o cuenta no son interacciones; su respuesta más reciente en el hilo se guarda como «respuesta existente».
* Publicación: sin clave idempotente en Meta. Tras un corte o 5xx al escribir, el motor consulta las respuestas del comentario y da por publicada la que tenga el mismo texto y sea de la página; si no está, reintenta. Nunca hay segunda publicación sin esa comprobación.
* Conexión: `POST /v1/clients/:id/connections/meta/start` → Facebook → `GET /v1/oauth/meta/callback` (state de un solo uso, solo se guarda el hash). Se guarda sellado el token de usuario; los **tokens de página solo se guardan para las páginas elegidas** (`POST /v1/meta/credentials/:id/connect`). La lista (`GET …/assets`) indica por página y cuenta si se puede leer y responder según permisos y rol.
* Webhooks: `GET/POST /v1/webhooks/meta`. El cuerpo se verifica sobre los bytes recibidos; cada aviso se registra en `private.webhook_events` (id = hash de objeto, página, campo, comentario, verbo y hora) y solo el primero encola una sincronización (`trigger = 'webhook'`). El contenido se vuelve a leer de la API, nunca del aviso. Sin `META_WEBHOOK_VERIFY_TOKEN` el webhook responde 404 y se sincroniza solo por sondeo.
* Desconexión: al soltar la última fuente de una autorización se da de baja la suscripción de las páginas que ya no usa nadie y se revoca la app (`DELETE /me/permissions`) **solo si ninguna otra autorización vigente es del mismo usuario de Facebook** (revocar invalida todos sus tokens de página). `provider_user_ref` guarda un HMAC del id de usuario, no el id.
* No incluido todavía: menciones de Instagram, valoraciones/recomendaciones de la página, respuestas entre usuarios dentro de un hilo, ocultar o borrar comentarios.

### Cómo crear la app de Meta (lo hace Leo)

1. <https://developers.facebook.com/apps> con la cuenta de Facebook que administra las páginas → «Crear app» → caso de uso **«Gestionar todo en tu página»** / tipo **Empresa**, asociada al portfolio comercial de ELIGEMENU.
2. Añadir el producto **Inicio de sesión con Facebook para empresas** y, en su configuración, el URI de redirección que muestra la pantalla Fuentes (`…/v1/oauth/meta/callback`). En local, Meta acepta `http://localhost` mientras la app está en modo desarrollo; en producción, solo https.
3. Permisos: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_metadata`, `instagram_basic`, `instagram_manage_comments`.
4. En modo desarrollo solo funcionan las personas con rol en la app (administrador, desarrollador o tester). Para clientes externos: verificación de la empresa + **App Review** de cada permiso con vídeo de demostración, política de privacidad pública y URL de eliminación de datos.
5. Webhooks (solo con URL pública https): objeto **Page**, campo `feed`; objeto **Instagram**, campo `comments`. URL = la que muestra Fuentes (`…/v1/webhooks/meta`) y el token de verificación que elijas.
6. En `apps/api/.env` (nunca en el chat ni en el repositorio): `META_APP_ID`, `META_APP_SECRET` (Configuración → Básica → Clave secreta) y, si hay webhook, `META_WEBHOOK_VERIFY_TOKEN`. Reiniciar API y worker.

## Monitorización web

**Hallazgo importante:**
* **Google Custom Search JSON API** está cerrada a nuevos clientes y se apaga el **1/1/2027**.
* **Bing Search APIs** se retiraron el **11/08/2025**.

Por tanto no se puede basar el módulo en ninguno de los dos. Diseño: interfaz `SearchProvider` intercambiable con implementaciones candidatas que operan mediante API oficial y términos que permiten el uso: **Brave Search API** (índice propio, API comercial), proveedores de noticias con licencia, y **RSS/Atom** declarados por los medios. Decisión de proveedor pendiente (coste/cobertura en España) → ver `DECISIONS.md` ADR-009.

Reglas: no se hace scraping que vulnere términos o `robots.txt`; se guarda URL normalizada, título, extracto breve permitido, fecha de publicación, fecha de observación, proveedor consultado y sus limitaciones; desambiguación por dominio oficial, variantes, exclusiones, ubicación e idioma; protección SSRF al descargar cualquier URL (solo http/https, resolución DNS sin IPs privadas, límites de tamaño y tiempo).

## Proveedor simulado (implementado en F2)

`packages/connectors/src/simulator.ts` implementa el contrato completo con datos **ficticios** (autores marcados «(ficticio)», `is_simulated = true`, etiqueta «Simulado» en la interfaz). Solo existe fuera de producción (`NODE_ENV !== 'production'`).

* Capacidades declaradas: lectura de reseñas y respuestas, publicación y consulta de estado. No declara OAuth, ubicaciones ni webhooks (devuelven `not_supported`).
* Modos de publicación configurables por fuente: correcta, **ambigua** (publica pero responde con error de tiempo de espera), límite de peticiones (`retryAfterSec = 30`), error definitivo del proveedor, credenciales caducadas.
* Modos de sincronización: correcta, error temporal (HTTP 503 simulado), credenciales caducadas.
* Acciones de desarrollo: generar reseñas ficticias (incluye casos delicados: reclamación legal, problema de salud, intento de inyección de instrucciones) y simular que el autor edita su reseña.
* Su «lado remoto» vive en `private.simulator_items` y `private.simulator_remote` (ADR-018).
