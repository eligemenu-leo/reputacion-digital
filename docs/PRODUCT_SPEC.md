# Especificación de producto

Resumen operativo de la especificación original (hilo del proyecto, 13/11/2026) y del análisis de la Fase 0.

## Visión

SaaS multiempresa para que una agencia gestione centralmente la reputación digital de muchos clientes: monitorizar fuentes autorizadas, detectar reseñas/comentarios/menciones, analizarlos con IA, proponer respuestas y publicarlas **solo tras aprobación humana**, con todo auditado.

Jerarquía: **Organización → Cliente → Ubicación → Fuentes conectadas → Interacciones.**

## Alcance del MVP

* **Incluido:** Google Business Profile, Facebook (Páginas), Instagram (cuentas profesionales), monitorización web por proveedores autorizados, bandeja única, estados, borradores IA, aprobaciones, publicación verificada, alertas (in-app + email), informes con CSV.
* **Fuera:** TheFork, Tripadvisor, LinkedIn, TikTok, foros, análisis avanzado de imágenes, competencia, publicación 100 % automática, campañas, facturación, apps nativas, publicación de contenido social. La arquitectura (contrato de conectores, `provider` como texto, capacidades declaradas) permite añadirlos sin rediseño.

## Roles

Superadministrador · Administrador de organización · Gestor de cuentas · Aprobador (permiso por cliente) · Cliente (lectura, fase posterior). Detalle en `DATA_MODEL.md`.

## Análisis de la Fase 0: contradicciones, ambigüedades y cómo se resuelven

| # | Tema | Resolución |
|---|---|---|
| 1 | «La información se actualizará automáticamente» vs. dependencias de aprobación externa (Google/Meta) | Las fuentes muestran estado real («Pendiente de autorización», «Acceso insuficiente»…). Hasta tener acceso, solo el **simulador** (dev/test) genera datos, siempre marcados como ficticios. |
| 2 | «Monitorizar diariamente» todo Internet vs. «no prometer cobertura completa» | Se registra proveedor, fecha de consulta y limitaciones por resultado. Además, las dos APIs de búsqueda clásicas ya no están disponibles (Google CSE cierra 1/1/2027; Bing retirada 2025): proveedor por decidir (ADR-009). |
| 3 | Dashboard con «Evolución de sentimiento», «Alertas activas»… desde la Fase 1 vs. «no usar valores simulados» | El panel de F1 muestra solo métricas con datos reales (clientes, ubicaciones, equipo) y declara el resto como pendiente por fase. |
| 4 | «Aprobar y publicar únicamente si tiene permiso» (gestor) vs. aprobador como permiso específico | Permisos separados `responses.approve` y `responses.publish`; el rol `approver` se concede **por cliente**. Un gestor puede tenerlo en unos clientes y no en otros. |
| 5 | «Bloquear la publicación automática» en casos graves, cuando el MVP ya no publica automáticamente | Se interpreta como **bloqueo reforzado**: la aprobación normal no basta; requiere marcar la revisión especializada (permiso adicional o segundo aprobador, a definir en F2). |
| 6 | Instagram: «detección de menciones cuando estén autorizadas» | Solo vía la funcionalidad oficial de menciones y webhooks; capacidades por cuenta, sin asumir paridad con Facebook. |
| 7 | Rol «Cliente» previsto para el futuro | Rol `client_viewer` ya creado (sin UI). Cuando se habilite, la RLS por cliente ya lo soporta. |
| 8 | Superadministrador con «monitorización global» vs. minimización de datos de tenants | Acceso total auditado en el MVP; *break-glass* a evaluar en F6 (ADR-006). |
| 9 | Autor de reseñas «cuando esté disponible y permitido» + RGPD | Nombre visible + identificador seudonimizado; nada del autor se envía a la IA. |
| 10 | Confianza de la IA como número | Se presenta como baja/media/alta y se documenta como no calibrada hasta evaluar empíricamente. |
| 11 | MFA «para perfiles administrativos» | Implementado como exigencia de `aal2` en acciones sensibles (configurable por organización, obligatorio en producción). |

## Dependencias externas (bloqueos)

| Dependencia | Necesaria para | Responsable |
|---|---|---|
| Proyecto Supabase de staging/producción (coste) | Desplegar | Leo (aprobación de coste) |
| Proyecto Google Cloud + acceso a Business Profile APIs + perfil verificado 60+ días | Fase 4 (Google) | Leo / agencia |
| App de Meta Business + verificación de empresa + App Review | Fase 4 (Facebook/Instagram) | Leo / agencia |
| Clave de OpenAI + DPA | Fase 3 | Leo |
| Proveedor de búsqueda web (contrato) | Fase 4 (web) | Leo (decisión comercial) |
| SMTP transaccional (p. ej. Resend, Postmark, SES) | Invitaciones y alertas por email en producción | Leo |
| Dominio y hosting de API/web | Producción | Leo |
| Textos legales: política de privacidad, contrato de encargado, URL de borrado de datos (requisito de Meta) | Producción / App Review | Leo / asesoría legal |
