# syntax=docker/dockerfile:1
# API y worker de la plataforma (una sola imagen; Fly.io arranca cada proceso).
# Construcción: docker build -t reputacion-api .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/connectors/package.json packages/connectors/
# El secreto «ca» es opcional: solo para construir detrás de un proxy con CA propia.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && pnpm install --frozen-lockfile --filter @rep/api...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @rep/api build \
 && pnpm --filter @rep/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 8787
# Por defecto, la API. El worker se arranca con: node dist/worker.js
CMD ["node", "--enable-source-maps", "dist/server.js"]
