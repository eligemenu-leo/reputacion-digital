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

## Build de la API

En Fase 2 se añadirá un `Dockerfile` multi-stage que empaqueta API y worker con sus paquetes del workspace. Hasta entonces `pnpm --filter @rep/api dev` (tsx) es la forma soportada de ejecutarla.

## Copias de seguridad y recuperación

* Supabase: backups diarios gestionados + **PITR** en producción.
* Procedimiento de restauración (probar trimestralmente en staging): restaurar a un proyecto nuevo con PITR → verificar `supabase db lint` + suite RLS contra la copia → cambiar `DATABASE_URL` de API/worker.
* Las migraciones son *forward-only*; para revertir se escribe una migración compensatoria revisada.

## Rotación de secretos

* `SUPABASE_SERVICE_ROLE_KEY` / claves de firma: rotar desde el panel de Supabase, actualizar el gestor de secretos y reiniciar API/worker.
* Secretos de apps de Google/Meta y `OPENAI_API_KEY`: rotación semestral o inmediata ante sospecha.

## Observabilidad

* Logs JSON (Pino) con `requestId`, sin cabeceras de autorización; enviar a un agregador (Better Stack, Grafana Loki, Datadog…).
* `/health` (vivo) y `/health/ready` (BD accesible) para el orquestador.
* Errores no controlados: Sentry (o equivalente) en API y web — pendiente de elegir proveedor (F2).
