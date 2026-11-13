import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().default(8787),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    SUPABASE_URL: z.string().url().optional(),
    /** Secreto HS256 legado (local/CLI). En proyectos con claves asimétricas se usa JWKS. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    SUPABASE_JWT_ISSUER: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    APP_URL: z.string().url().default('http://localhost:5173'),
    ENFORCE_ADMIN_MFA: bool.prefault('true'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  })
  .refine((c) => c.SUPABASE_JWT_SECRET || c.SUPABASE_URL, {
    message: 'Se requiere SUPABASE_URL (JWKS) o SUPABASE_JWT_SECRET para verificar tokens',
  })
  .refine((c) => c.NODE_ENV !== 'production' || c.ENFORCE_ADMIN_MFA, {
    message: 'ENFORCE_ADMIN_MFA no puede desactivarse en producción',
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // No se imprime el entorno completo para no filtrar secretos.
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(config)'}: ${i.message}`,
    );
    throw new Error(`Configuración inválida:\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}
