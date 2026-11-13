# UX / UI

## Principios

* **Control y claridad**: cada pantalla responde a «¿qué requiere mi atención?». Sin gráficos decorativos ni métricas simuladas: un módulo sin datos reales muestra su estado («Pendiente · Fase N»).
* **Mínimo esfuerzo**: navegación lateral corta, filtros visibles y persistidos en la URL, paneles laterales (*sheets*) para crear/editar sin perder el contexto, acciones principales siempre arriba a la derecha.
* **Confianza**: confirmaciones explícitas para acciones sensibles (eliminar, suspender publicaciones), toasts discretos, errores con causa y opción de reintento, estados vacíos que explican el siguiente paso.

## Sistema visual

* Tipografía Inter Variable autoalojada (sin llamadas a Google Fonts: RGPD).
* Tokens de color en CSS (`apps/web/src/index.css`) con modo claro/oscuro; el tema se aplica antes del primer pintado. Acento índigo; estados semánticos success/warning/danger con fondo suave.
* Contraste: texto secundario ≥ 6:1 en claro y ≥ 7:1 en oscuro.
* Radios 8–12 px, bordes finos, sombras solo en capas flotantes.
* Animaciones 150–200 ms; desactivadas con `prefers-reduced-motion`.
* Componentes base: `Button`, `Field` (+`Input`/`Select`/`Textarea`/`Switch`), `Badge`, `Card`, `Sheet`, `ConfirmDialog`, `Toast`, `EmptyState`, `ErrorState`, `Skeleton`, `PageHeader`. Radix para diálogos y menús (foco atrapado, Escape, ARIA).

## Accesibilidad (objetivo WCAG 2.2 AA)

Hecho en F1: enlace «Saltar al contenido», landmarks (`nav`, `main`), etiquetas asociadas a todos los campos, `aria-invalid` + `aria-describedby` para errores (con test), `role="alert"` en errores, `aria-live` en notificaciones, `role="switch"`/`aria-checked`, pestañas con `role="tab"`/`aria-selected`, tablas con `caption` y `scope`, objetivos táctiles ≥ 32 px, foco visible. Pendiente F6: auditoría axe completa, navegación por teclado en pestañas con flechas, pruebas con lector de pantalla.

## Responsive

* Escritorio: barra lateral fija de 256 px.
* Tablet/móvil: cabecera con menú en panel deslizante; tablas ocultan columnas secundarias; formularios a una columna.
* Aprobaciones y revisión rápida (F2) se diseñarán *mobile-first*: tarjeta por interacción con acciones Aprobar/Editar/Devolver al alcance del pulgar.

## Pantallas (spec §10)

| # | Pantalla | Estado |
|---|---|---|
| 1 | Acceso, recuperación, nueva contraseña, MFA | ✅ F1 |
| 2 | Dashboard | ✅ F1 (datos reales disponibles; módulos futuros declarados) |
| 3-6 | Clientes: listado, alta/edición, ficha, ubicaciones | ✅ F1 |
| 7 | Perfiles conectados | F4 |
| 8-10 | Bandeja, detalle, editor de respuesta IA | F2/F3 |
| 11 | Aprobaciones | F2 |
| 12-13 | Alertas, informes | F5 |
| 14 | Personalidad de marca | F3 (tabla ya creada) |
| 15 | Usuarios y permisos | ✅ F1 (roles personalizados: F2) |
| 16 | Configuración general (organización, interruptor de publicación, MFA) | ✅ F1 |
| 17 | Monitor de integraciones | F4 |
| 18 | Auditoría administrativa | ✅ F1 |
| — | Administración de plataforma (superadmin) y Mi cuenta | ✅ F1 |

Capturas de la Fase 1: generadas por la prueba e2e (`SHOTS_DIR`).
