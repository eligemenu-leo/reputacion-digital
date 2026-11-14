import { PgBoss } from 'pg-boss';
import { QUEUES, type JobQueue, type QueueName } from './queue';

export function createBoss(connectionString: string, opts: { worker: boolean }) {
  // La API solo envía: no supervisa ni ejecuta cron. El worker hace ambas cosas.
  return new PgBoss({
    connectionString,
    schema: 'pgboss',
    max: 4,
    supervise: opts.worker,
    schedule: opts.worker,
    migrate: true,
  });
}

export async function ensureQueues(boss: PgBoss) {
  // Los reintentos de negocio los gestiona el dominio (consultando antes el estado remoto);
  // pg-boss solo reintenta si el proceso falla de forma inesperada.
  await boss.createQueue(QUEUES.sync, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 900,
  });
  await boss.createQueue(QUEUES.publish, {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  });
  await boss.createQueue(QUEUES.sweep, {
    retryLimit: 0,
    expireInSeconds: 120,
    policy: 'singleton',
  });
}

export class PgBossQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}
  async send(name: QueueName, data: { id: string }, opts?: { startAfterSeconds?: number }) {
    await this.boss.send(name, data, {
      startAfter: opts?.startAfterSeconds,
      // Evita avisos duplicados para la misma fila mientras haya uno pendiente.
      singletonKey: opts?.startAfterSeconds ? undefined : data.id,
    });
  }
}
