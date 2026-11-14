/**
 * Worker de trabajos en segundo plano (sincronización, publicación, barrido).
 * Comparte los servicios de dominio con la API (ADR-013). Se ejecuta como
 * proceso aparte: `pnpm --filter @rep/api start:worker`.
 */
import { loadConfig } from './config';
import { createDb } from './lib/db';
import { createConnectorRegistry } from './domain/connectors';
import { createIntegrations } from './domain/credentials';
import { sweepCredentials } from './domain/connection-lifecycle';
import { createBoss, ensureQueues, PgBossQueue } from './domain/pgboss-queue';
import { QUEUES } from './domain/queue';
import { runPublish, sweepPublications, sweepSyncRuns } from './domain/publish';
import { runSync, scheduleDueSyncs, type JobDeps } from './domain/sync';
import { aiRuntimeFromConfig, runClassify, sweepClassifications, type AiDeps } from './ai/service';

const config = loadConfig();
const sql = createDb(config);
const boss = createBoss(config.DATABASE_URL, { worker: true });
const log = {
  info: (o: object, m: string) =>
    void process.stdout.write(JSON.stringify({ level: 'info', msg: m, ...o }) + '\n'),
  warn: (o: object, m: string) =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: m,
        ...o,
        err: String((o as { err?: unknown }).err ?? ''),
      }),
    ),
};
boss.on('error', (err) => log.warn({ err }, 'pg-boss error'));

await boss.start();
await ensureQueues(boss);
const integrations = createIntegrations(config);
const deps: JobDeps = {
  sql,
  registry: createConnectorRegistry(sql, integrations),
  queue: new PgBossQueue(boss),
  authorRefPepper: config.AUTHOR_REF_PEPPER,
  log,
};
const ai = aiRuntimeFromConfig(config);
deps.aiAutoClassify = Boolean(ai) && config.AI_AUTO_CLASSIFY;
const aiDeps: AiDeps = { sql, ai, queue: deps.queue, log };
log.info({ provider: ai?.provider.name ?? 'none', models: ai?.models ?? null }, 'ai runtime');
log.info(
  {
    google: Boolean(integrations.google),
    meta: Boolean(integrations.meta),
    metaWebhooks: Boolean(integrations.meta?.webhookVerifyToken),
  },
  'integrations',
);

await boss.work<{ id: string }>(QUEUES.sync, { localConcurrency: 4 }, async ([job]) => {
  if (job) await runSync(deps, job.data.id);
});
await boss.work<{ id: string }>(QUEUES.publish, { localConcurrency: 2 }, async ([job]) => {
  if (job) await runPublish(deps, job.data.id);
});
await boss.work<{ id: string }>(QUEUES.classify, { localConcurrency: 4 }, async ([job]) => {
  if (job) await runClassify(aiDeps, job.data.id);
});
await boss.work(QUEUES.sweep, async () => {
  const syncs = await scheduleDueSyncs(deps);
  const pubs = await sweepPublications(deps);
  const runs = await sweepSyncRuns(deps);
  const ais = ai ? await sweepClassifications(aiDeps) : 0;
  const creds = await sweepCredentials(sql, integrations);
  if (syncs + pubs + runs + ais + creds) log.info({ syncs, pubs, runs, ais, creds }, 'sweep');
});
await boss.schedule(QUEUES.sweep, '* * * * *');
log.info({}, 'worker started');

const shutdown = async (signal: string) => {
  log.info({ signal }, 'worker shutting down');
  await boss.stop({ graceful: true, timeout: 20_000 });
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
