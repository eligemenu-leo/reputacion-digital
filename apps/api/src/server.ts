import { loadConfig } from './config';
import { buildApp } from './app';
import { createDb } from './lib/db';
import { createTokenVerifier } from './lib/auth';
import { createAuthAdmin } from './lib/supabase-admin';
import { createBoss, ensureQueues, PgBossQueue } from './domain/pgboss-queue';
import type { JobQueue } from './domain/queue';
import { aiRuntimeFromConfig } from './ai/service';
import { createIntegrations } from './domain/credentials';

const config = loadConfig();
const sql = createDb(config);
let boss: ReturnType<typeof createBoss> | null = null;
let queue: JobQueue = {
  // Sin cola: las filas quedan en estado «queued» y el worker las recogerá en su barrido.
  send: async () => {},
};
if (config.JOBS_ENABLED) {
  boss = createBoss(config.DATABASE_URL, { worker: false });
  boss.on('error', (err) => console.error('pg-boss', err));
  await boss.start();
  await ensureQueues(boss);
  queue = new PgBossQueue(boss);
}
const app = await buildApp({
  config,
  sql,
  verifyToken: createTokenVerifier(config),
  authAdmin: createAuthAdmin(config),
  queue,
  ai: aiRuntimeFromConfig(config),
  integrations: createIntegrations(config),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await boss?.stop({ graceful: true, timeout: 10_000 });
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
