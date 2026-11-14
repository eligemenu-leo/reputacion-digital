import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { AppError, type ApiErrorBody } from '@rep/shared';
import type { Config } from './config';
import type { AuthContext, TokenVerifier } from './lib/auth';
import type { AuthAdmin } from './lib/supabase-admin';
import type { Sql } from './lib/db';
import { mapDbError } from './lib/http';
import { meRoutes } from './routes/me';
import { organizationRoutes } from './routes/organizations';
import { memberRoutes } from './routes/members';
import { clientRoutes } from './routes/clients';
import { interactionRoutes } from './routes/interactions';
import { connectionRoutes } from './routes/connections';
import type { JobQueue } from './domain/queue';
import type { AiRuntime } from './ai/service';
import { aiRoutes } from './routes/ai';
import { brandRoutes } from './routes/brand';
import { reportRoutes } from './routes/reports';
import { googleRoutes } from './routes/google';
import type { Integrations } from './domain/credentials';

export interface AppDeps {
  config: Config;
  sql: Sql;
  verifyToken: TokenVerifier;
  authAdmin: AuthAdmin;
  /** Avisos al worker (pg-boss en ejecución; en memoria en pruebas). */
  queue: JobQueue;
  /** Proveedor de IA (null = IA no configurada en este entorno). */
  ai: AiRuntime | null;
  /** Proveedores reales configurados (OAuth) y caja de sellado de credenciales. */
  integrations: Integrations;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Inicia sesión para continuar');
  return req.auth;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            // Nunca registrar credenciales.
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
          },
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{8,64}$/.test(h) ? h : randomUUID();
    },
    bodyLimit: 1_000_000,
    trustProxy: true,
  });

  app.decorate('deps', deps);
  app.decorateRequest('auth', null);

  await app.register(helmet, { contentSecurityPolicy: false }); // API JSON; la CSP la sirve el frontend
  await app.register(cors, {
    origin: deps.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: false, // Auth por Bearer token: sin cookies → sin superficie CSRF
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, {
    max: deps.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      req.auth = await deps.verifyToken(h.slice(7));
    }
  });

  app.setErrorHandler((err, req, reply) => {
    let appErr: AppError | null = err instanceof AppError ? err : mapDbError(err);
    if (!appErr && (err as { statusCode?: number }).statusCode === 429) {
      appErr = new AppError('RATE_LIMITED', 'Demasiadas peticiones');
    }
    if (!appErr && (err as { validation?: unknown }).validation) {
      appErr = new AppError('VALIDATION', 'Petición no válida');
    }
    if (!appErr) {
      req.log.error({ err }, 'unhandled error');
      appErr = new AppError('INTERNAL', 'Error interno');
    }
    const body: ApiErrorBody = {
      error: {
        code: appErr.code,
        message: appErr.message,
        details: appErr.details,
        requestId: req.id,
      },
    };
    void reply.status(appErr.status).send(body);
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await deps.sql`select 1`;
    return { status: 'ready' };
  });

  await app.register(
    async (v1) => {
      await v1.register(meRoutes);
      await v1.register(organizationRoutes);
      await v1.register(memberRoutes);
      await v1.register(clientRoutes);
      await v1.register(interactionRoutes);
      await v1.register(connectionRoutes);
      await v1.register(googleRoutes);
      await v1.register(aiRoutes);
      await v1.register(brandRoutes);
      await v1.register(reportRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
