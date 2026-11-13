import { loadConfig } from './config';
import { buildApp } from './app';
import { createDb } from './lib/db';
import { createTokenVerifier } from './lib/auth';
import { createAuthAdmin } from './lib/supabase-admin';

const config = loadConfig();
const sql = createDb(config);
const app = await buildApp({
  config,
  sql,
  verifyToken: createTokenVerifier(config),
  authAdmin: createAuthAdmin(config),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
