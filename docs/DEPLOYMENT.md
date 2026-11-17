# Despliegue y operación

## Desarrollo local

Requisitos: Node 22, pnpm 10, Docker (para Supabase local).

```bash
pnpm install
npx supabase start                    # Postgres 17 + Auth + Mailpit; aplica supabase/migrations
npx supabase status -o env            # copia URL y claves a los .env (ver .env.example)
cp apps/api/.env.example apps/api/.env   # completa DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY…
cp apps/web/.env.example apps/web/.env   # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL
pnpm --filter @rep/api bootstrap:superadmin --email tu@email --password 'una-contraseña-larga'
pnpm dev                              # API :8787 · web :5173 · emails en http://127.0.0.1:54324
pnpm --filter @rep/api dev:worker     # worker: sincronizaciones y publicaciones (pg-boss)
```

Con `supabase start` se excluyen servicios no usados para ir más rápido:
`npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,realtime,storage-api,postgres-meta,supavisor`

## Entornos

| | staging | producción |
|---|---|---|
| Supabase | proyecto propio, región UE | proyecto propio, región UE, plan con PITR |
| API/worker | contenedor Node 22 (1 instancia) | ≥ 2 instancias API, 1-N worker |
| Web | CDN estática | CDN estática |
| Google/Meta | apps en modo desarrollo/prueba | apps aprobadas (App Review / acceso GBP) |
| Datos | ficticios | reales |

**Ningún proyecto Supabase de pago se crea sin la aprobación expresa de Leo.** El proyecto existente `eligemenu` pertenece a otro producto y no debe usarse.

## Pasos para un entorno nuevo

1. Crear proyecto Supabase (UE). Activar claves de firma asimétricas (JWT Signing Keys).
2. Auth: `Site URL` = URL de la web; Redirect URLs = `<web>/auth/callback`, `<web>/nueva-contrasena`; desactivar registro público; contraseña mínima 12; MFA TOTP activado; SMTP propio (no el de pruebas de Supabase).
3. Migraciones: `npx supabase link --project-ref <ref>` y `npx supabase db push` (revisar el plan antes de confirmar).
4. API: variables de `apps/api/.env.example` en el gestor de secretos del hosting (`ENFORCE_ADMIN_MFA=true` es obligatorio en producción; la API se niega a arrancar si no).
5. Web: `VITE_*` en el build; servir `apps/web/dist` con fallback SPA a `index.html` y cabeceras:
   * `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<hash del script de tema>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://<ref>.supabase.co https://<api>; frame-ancestors 'none'; base-uri 'self'`
   * `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
6. Primer superadministrador: `bootstrap:superadmin` desde una máquina de confianza.

## Build de la API y del worker

```bash
pnpm --filter @rep/api build          # esbuild → apps/api/dist/server.js y dist/worker.js
node --env-file=.env apps/api/dist/server.js    # API
node --env-file=.env apps/api/dist/worker.js    # worker (1-N instancias)
```

Las dependencias de terceros se resuelven desde `node_modules` (instalar con `pnpm install --prod --filter @rep/api...`); los paquetes del monorepo van dentro del bundle. Variables nuevas en F2:

* `AUTHOR_REF_PEPPER` (obligatoria en producción, ≥ 16 caracteres): seudonimiza los identificadores de autores.
* IA (API y worker): `OPENAI_API_KEY` (solo servidor; sin ella la IA queda desactivada y la interfaz lo indica), `AI_PROVIDER` (`auto` por defecto; `fake` solo en development/test), `AI_MODEL_CLASSIFY` (`gpt-5.4-mini`), `AI_MODEL_DRAFT` (`gpt-5.4`), `AI_MODEL_SUMMARY` (`gpt-5.4`), `AI_PRICES` (JSON opcional), `AI_TIMEOUT_MS`, `AI_AUTO_CLASSIFY` (`true`). La clave se rota en el panel de OpenAI y se sustituye en el entorno; no se guarda en la base de datos.
* `JOBS_ENABLED` (por defecto `true`): la API envía avisos a pg-boss. Si es `false`, las filas quedan en cola y el worker las recoge en su barrido.
* pg-boss crea y migra su esquema `pgboss` al arrancar; el usuario de `DATABASE_URL` necesita permiso para ello.

Imagen: `Dockerfile` en la raíz (Node 22; API por defecto, worker con `node dist/worker.js`). Construcción local: `docker build -t reputacion-api .`.

## Producción elegida (2026-11-17): Supabase gratis + VPS IONOS (Plesk + Docker) + Cloudflare

Cambio respecto al plan del 16-nov: la API y el worker van al **VPS de IONOS** que Leo ya paga y usa para otros proyectos (Ubuntu 24.04, Plesk Obsidian), en lugar de Fly.io. Coste añadido: 0 €.

| Pieza | Dónde |
|---|---|
| Base de datos + Auth | Supabase Free, proyecto `reputacion-digital` (ref `msebvmmmfiryhcjntawx`, Fráncfort) |
| API + worker | VPS IONOS, extensión Docker de Plesk, `deploy/vps/compose.yml` |
| API pública | `https://api-reputacion.eligemenu.com` (DNS en Cloudflare, nube gris; certificado Let's Encrypt de Plesk; regla de proxy de Docker → `127.0.0.1:8787`) |
| Web | Cloudflare Pages en `https://reputacion.eligemenu.com` |

**Imagen:** `.github/workflows/image.yml` publica `ghcr.io/eligemenu-leo/reputacion-digital` (`:staging` desde la rama `fase-4b-meta`, `:latest` desde `main`, y `:sha-xxxxxxx`). La imagen no lleva secretos. Si el paquete de GHCR es privado, el VPS necesita `docker login ghcr.io` con un token de solo lectura; lo más simple es marcar el paquete como público (el código ya lo es).

**Secretos:** `deploy/vps/api.env` en el VPS, fuera de las carpetas web y con permisos 600 (plantilla: `api.env.example`). Claves nuevas para producción: `AUTHOR_REF_PEPPER` y `CREDENTIALS_ENCRYPTION_KEYS` no se reutilizan del Mac.

**DATABASE_URL:** pooler de Supabase en modo **sesión** (puerto 5432). La conexión directa es solo IPv6.

**Migraciones aplicadas** el 2026-11-17 con el conector MCP de Supabase: las versiones del historial remoto son marcas de tiempo de ese día, no las de `supabase/migrations`. Antes de usar `supabase db push` contra este proyecto, alinear el historial con `supabase migration repair` (marcar como aplicadas las 10 versiones del repo y revertir las del conector).

**Actualizar:** en Plesk → Docker, «Volver a descargar la imagen» y recrear los dos contenedores (o `docker compose pull && docker compose up -d` en `deploy/vps`).

## Plan anterior (descartado el 2026-11-17): Supabase gratis + Fly.io + Cloudflare

Leo eligió empezar sin coste fijo: **0–5 $/mes** más el consumo de OpenAI. Cuando haya clientes de pago, se pasa Supabase a Pro con un cambio de plan, sin migrar nada.

| Pieza | Servicio | Región | Coste |
|---|---|---|---|
| Base de datos + Auth | Supabase Free (2.º proyecto gratis de la cuenta; `eligemenu` no se toca) | UE (Fráncfort) | 0 $ |
| API (512 MB) + worker (256 MB) | Fly.io, `fly.toml` (procesos `app` y `worker`) | `fra` | ≈ 5 $; Fly no cobra facturas personales < 5 $ |
| Web | Cloudflare Pages (`apps/web/dist`, `_redirects` y `_headers` en `apps/web/public`) | CDN | 0 $ |
| Copias | GitHub Actions `backup.yml` → Cloudflare R2 (10 GB gratis), cifradas con age | UE | 0 $ |

Límites del plan gratuito y cómo se cubren:
* **Pausa tras 7 días sin actividad:** el worker sincroniza cada hora, así que el proyecto nunca está inactivo.
* **Sin copias recuperables:** se hace una copia diaria propia y cifrada (ver abajo).
* **500 MB:** de sobra para decenas de clientes.
* **Correo de Auth limitado:** para invitar al equipo, configurar un SMTP propio (el del dominio eligemenu.es).

### Pasos (cada cuenta se crea solo con el OK de Leo)

1. **Supabase:** crear el proyecto gratuito en la UE.
   * Auth → URL Configuration: Site URL = la web; Redirect URLs = `<web>/auth/callback` y `<web>/nueva-contrasena`.
   * Registro público desactivado, MFA TOTP activado y SMTP propio.
   * Migraciones: `npx supabase link --project-ref <ref>` y después `npx supabase db push`.
2. **Fly.io:**
   * `fly launch --no-deploy --copy-config --name <app>` (región `fra`).
   * Secretos: `fly secrets set` con `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTHOR_REF_PEPPER`, `CREDENTIALS_ENCRYPTION_KEYS`, `OPENAI_API_KEY`, `META_APP_ID`, `META_APP_SECRET`, `APP_URL`, `CORS_ORIGINS`, `API_PUBLIC_URL` y `ENFORCE_ADMIN_MFA=true`.
   * `DATABASE_URL` es la conexión directa de Supabase (IPv6, que Fly admite) o el pooler en modo sesión (puerto 5432). El pooler en modo transacción no sirve, porque lo impiden pg-boss y `set local`.
   * `fly deploy`.
3. **Cloudflare Pages:**
   * Conectar el repositorio, rama `main`.
   * Build: `pnpm install --frozen-lockfile && pnpm --filter @rep/web build`. Salida: `apps/web/dist`.
   * Variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` y `VITE_API_URL`.
4. **Meta:** en la app, añadir el dominio y la URI de redirección `https://<api>/v1/oauth/meta/callback`. Con `META_WEBHOOK_VERIFY_TOKEN`, el webhook es `https://<api>/v1/webhooks/meta`.
5. **Primer superadministrador:** `bootstrap:superadmin` con las variables de producción, desde el Mac de Leo.
6. **Datos:** se empieza desde cero y se vuelven a conectar las páginas. El histórico de 12 meses se carga solo. La base local del Mac no se migra.

## Copias de seguridad y recuperación

**Copia diaria propia (plan gratuito)**
* `.github/workflows/backup.yml` se ejecuta a las 03:30 (hora de Madrid) y a mano.
* `supabase db dump` (roles, esquema y datos) se empaqueta y se cifra con **age** en el runner, antes de salir de él.
* Después se sube a R2 como `db/<fecha>.tar.gz.age`. El repositorio es público: el volcado nunca se guarda como artefacto ni se imprime en el log.
* Configuración en GitHub:
  * Secrets: `SUPABASE_DB_URL` (pooler en modo sesión: los runners no tienen IPv6), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`.
  * Variables: `BACKUP_ENABLED=true`, `BACKUP_AGE_RECIPIENT` (clave pública age) y `R2_BUCKET`.
* La **clave privada de age** se guarda fuera de GitHub, en el gestor de contraseñas de Leo.
* Retención: una regla de ciclo de vida de R2 que borre lo de más de 30 días.
* Restaurar:
  1. `age -d -i clave.txt copia.tar.gz.age | tar -xz`
  2. En un proyecto vacío: `psql -f roles.sql`, después `psql -f schema.sql` y por último `psql -f data.sql`, con `session_replication_role = replica` para los datos.
  3. `supabase db lint` y la suite RLS.
  4. Cambiar `DATABASE_URL`.

**Con Supabase Pro**

* Supabase: backups diarios gestionados + **PITR** en producción.
* Procedimiento de restauración (probar trimestralmente en staging): restaurar a un proyecto nuevo con PITR → verificar `supabase db lint` + suite RLS contra la copia → cambiar `DATABASE_URL` de API/worker.
* Las migraciones son *forward-only*; para revertir se escribe una migración compensatoria revisada.

## Rotación de secretos

* `SUPABASE_SERVICE_ROLE_KEY` / claves de firma: rotar desde el panel de Supabase, actualizar el gestor de secretos y reiniciar API/worker.
* Secretos de apps de Google/Meta y `OPENAI_API_KEY`: rotación semestral o inmediata ante sospecha.
* `CREDENTIALS_ENCRYPTION_KEYS`: añadir la clave nueva **al principio** (`k2:…,k1:…`) y reiniciar; lo nuevo se sella con `k2` y lo antiguo se sigue abriendo con `k1`. Cada refresco de token vuelve a sellar con la clave actual; cuando ninguna fila tenga `key_id = 'k1'`, retirar `k1`. Perder todas las claves obliga a reconectar las fuentes (no se pierden datos de negocio).

## Observabilidad

* Logs JSON (Pino) con `requestId`, sin cabeceras de autorización; enviar a un agregador (Better Stack, Grafana Loki, Datadog…).
* `/health` (vivo) y `/health/ready` (BD accesible) para el orquestador.
* Errores no controlados: Sentry (o equivalente) en API y web — pendiente de elegir proveedor (F2).
