# Integraciones con proveedores

> Documentación verificada el **13/11/2026** contra la documentación oficial. Antes de implementar cada conector (Fase 4) se debe volver a verificar, porque los proveedores cambian versiones y permisos con frecuencia.

## Estado

| Proveedor | Estado | Bloqueo externo |
|---|---|---|
| Google Business Profile | 🔒 **Bloqueado** (diseño listo) | Solicitud de acceso a las Business Profile APIs (cuota 0 QPM hasta aprobación) |
| Facebook (Páginas) | 🔒 **Bloqueado** (diseño listo) | App de Meta + App Review de permisos avanzados + verificación de empresa |
| Instagram (cuentas profesionales) | 🔒 **Bloqueado** (diseño listo) | App de Meta + App Review |
| Monitorización web | 🔒 **Bloqueado** | Elegir y contratar proveedor de búsqueda (ver abajo) |
| Simulador | ⏳ Fase 2 | — (solo dev/test, datos marcados como ficticios) |

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

## Meta — Facebook (Páginas)

**Verificado:**
* Versión vigente de Graph API: **v26.0** (publicada 29/07/2026); v25.0 caduca 29/07/2028. Fuente: <https://developers.facebook.com/docs/graph-api/changelog/versions>
* Comentarios de Página: token de Página con `pages_manage_engagement`, `pages_read_engagement`, `pages_read_user_engagement`; el usuario necesita las tareas `MODERATE` y `CREATE_CONTENT`. Leer `GET /{page_post_id}/comments`; responder como Página `POST /{comment_id}/comments`. No se puede comentar si la Página no está publicada. Fuente: <https://developers.facebook.com/documentation/pages-api/comments-mentions.md>
* Webhooks de Página (campo `feed`) para nuevos comentarios.

**Diseño:** adaptador propio (`meta-facebook`), versión de API fijada por configuración (`META_GRAPH_VERSION=v26.0`) y revisada en cada release; tokens de Página de larga duración; verificación de webhooks con `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo crudo con el App Secret, comparación en tiempo constante), `hub.verify_token` para la suscripción y deduplicación por id de evento/comentario.

## Meta — Instagram

**Verificado** (<https://developers.facebook.com/docs/instagram-platform/comment-moderation>):
* Dos vías: *Instagram API with Instagram Login* (`instagram_business_basic`, `instagram_business_manage_comments`, host `graph.instagram.com`) o *Facebook Login for Business* (`instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`, host `graph.facebook.com`).
* Leer `GET /{ig-media-id}/comments`, respuestas `GET /{ig-comment-id}/replies`, responder `POST /{ig-comment-id}/replies`.
* Webhooks: campos `comments` y `live_comments`. Las menciones requieren la funcionalidad específica de menciones; no todos los contenidos (p. ej. historias, anuncios en ciertos formatos) son legibles o respondibles.

**Diseño:** adaptador separado de Facebook (no se asume igualdad funcional). `getCapabilities()` reportará solo lo concedido. Recomendado: Facebook Login for Business para que una misma app de Meta gestione Páginas e Instagram vinculados.

**Dependencias:** app de Meta (tipo Business), verificación de la empresa, App Review de cada permiso avanzado con vídeo de demostración, política de privacidad pública, URL de borrado de datos.

## Monitorización web

**Hallazgo importante:**
* **Google Custom Search JSON API** está cerrada a nuevos clientes y se apaga el **1/1/2027**.
* **Bing Search APIs** se retiraron el **11/08/2025**.

Por tanto no se puede basar el módulo en ninguno de los dos. Diseño: interfaz `SearchProvider` intercambiable con implementaciones candidatas que operan mediante API oficial y términos que permiten el uso: **Brave Search API** (índice propio, API comercial), proveedores de noticias con licencia, y **RSS/Atom** declarados por los medios. Decisión de proveedor pendiente (coste/cobertura en España) → ver `DECISIONS.md` ADR-009.

Reglas: no se hace scraping que vulnere términos o `robots.txt`; se guarda URL normalizada, título, extracto breve permitido, fecha de publicación, fecha de observación, proveedor consultado y sus limitaciones; desambiguación por dominio oficial, variantes, exclusiones, ubicación e idioma; protección SSRF al descargar cualquier URL (solo http/https, resolución DNS sin IPs privadas, límites de tamaño y tiempo).
