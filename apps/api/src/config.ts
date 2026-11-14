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
    /** Pimienta para seudonimizar identificadores de autores (HMAC). Obligatoria en producción. */
    AUTHOR_REF_PEPPER: z.string().min(16).default('dev-only-author-pepper-not-secret'),
    /** Envía trabajos a pg-boss. En tests se sustituye por una cola en memoria. */
    JOBS_ENABLED: bool.prefault('true'),
    /**
     * Proveedor de IA. 'auto' = OpenAI si hay clave; si no, IA desactivada.
     * 'fake' (reglas deterministas, sin llamadas externas) solo en development/test.
     */
    AI_PROVIDER: z.enum(['auto', 'openai', 'fake', 'none']).default('auto'),
    OPENAI_API_KEY: z.string().min(20).optional(),
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    AI_MODEL_CLASSIFY: z.string().min(1).default('gpt-5.4-mini'),
    AI_MODEL_DRAFT: z.string().min(1).default('gpt-5.4'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(45_000),
    /** Sustituye la tabla de precios (USD por millón de tokens): {"modelo":{"input":n,"output":n}}. */
    AI_PRICES: z
      .string()
      .optional()
      .transform((s, ctx) => {
        if (!s) return undefined;
        try {
          return z
            .record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) }))
            .parse(JSON.parse(s));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'AI_PRICES no es un JSON válido' });
          return z.NEVER;
        }
      }),
    /** Clasificar automáticamente las interacciones nuevas al sincronizar. */
    AI_AUTO_CLASSIFY: bool.prefault('true'),
  })
  .refine((c) => c.SUPABASE_JWT_SECRET || c.SUPABASE_URL, {
    message: 'Se requiere SUPABASE_URL (JWKS) o SUPABASE_JWT_SECRET para verificar tokens',
  })
  .refine((c) => c.NODE_ENV !== 'production' || !c.AUTHOR_REF_PEPPER.startsWith('dev-only'), {
    message: 'AUTHOR_REF_PEPPER debe configurarse en producción',
  })
  .refine(
    (c) => c.AI_PROVIDER !== 'fake' || c.NODE_ENV === 'development' || c.NODE_ENV === 'test',
    {
      message: 'AI_PROVIDER=fake solo se permite en development o test',
    },
  )
  .refine((c) => c.AI_PROVIDER !== 'openai' || Boolean(c.OPENAI_API_KEY), {
    message: 'AI_PROVIDER=openai requiere OPENAI_API_KEY',
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
