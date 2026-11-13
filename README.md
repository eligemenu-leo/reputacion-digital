# Plataforma de Reputación Digital

SaaS multiempresa para que agencias gestionen la reputación digital de sus clientes: monitorización de reseñas, comentarios y menciones; análisis y redacción asistidos por IA; **publicación solo tras aprobación humana**; auditoría completa.

> **Estado:** Fase 0 (arquitectura) y Fase 1 (fundamentos) completadas. Las integraciones con Google, Meta, OpenAI y búsqueda web están **bloqueadas** a la espera de accesos externos. Ver [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Stack

React 19 · Vite · Tailwind 4 · TypeScript estricto · Fastify 5 · Zod 4 · PostgreSQL / Supabase (Auth + RLS) · pg-boss (F2) · OpenAI (F3)

## Estructura

```
apps/web        SPA (login, panel, clientes, usuarios, configuración, auditoría)
apps/api        API HTTP con autorización en servidor + RLS
packages/shared Permisos, esquemas de validación, errores, máquina de estados
packages/connectors  Contrato común de conectores y deduplicación
supabase/       Migraciones SQL y configuración del stack local
docs/           Documentación del producto y la arquitectura
```

## Puesta en marcha

```bash
pnpm install
npx supabase start            # requiere Docker
# completa apps/api/.env y apps/web/.env a partir de los .env.example y `npx supabase status -o env`
pnpm --filter @rep/api bootstrap:superadmin --email tu@email --password '…'
pnpm dev                      # web http://localhost:5173 · API http://localhost:8787
```

Detalles en [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Calidad

```bash
pnpm lint && pnpm typecheck && pnpm format:check
pnpm test                     # unitarias + RLS + integración (necesita PostgreSQL ≥ 15, ver TEST_PLAN)
node apps/web/e2e/phase1-smoke.mjs   # e2e contra el stack local
```

## Documentación

[Especificación](docs/PRODUCT_SPEC.md) · [Arquitectura](docs/ARCHITECTURE.md) · [Modelo de datos](docs/DATA_MODEL.md) · [Seguridad](docs/SECURITY.md) · [Integraciones](docs/INTEGRATIONS.md) · [IA](docs/AI_DESIGN.md) · [UX/UI](docs/UX_UI.md) · [Pruebas](docs/TEST_PLAN.md) · [Despliegue](docs/DEPLOYMENT.md) · [Decisiones](docs/DECISIONS.md) · [Progreso](docs/PROGRESS.md)
