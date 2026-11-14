/**
 * Cola de trabajos en segundo plano.
 *
 * Patrón «outbox»: la fuente de verdad son las filas de `provider_sync_runs` y
 * `publication_jobs` (estado `queued`) y `external_interactions.ai_status = 'pending'`. El mensaje en la cola es solo un aviso
 * que se envía DESPUÉS de confirmar la transacción. Si se pierde (caída entre
 * commit y envío), el barrido periódico del worker vuelve a encolarlo. Los
 * manejadores son idempotentes: reclaman la fila con `update … where status =
 * 'queued'`, así que un aviso duplicado no hace nada.
 */
export const QUEUES = {
  sync: 'sync.account',
  publish: 'publish.reply',
  sweep: 'maintenance.sweep',
  classify: 'ai.classify',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobQueue {
  send(name: QueueName, data: { id: string }, opts?: { startAfterSeconds?: number }): Promise<void>;
}

/** Cola que solo registra los envíos (pruebas). Los tests ejecutan los manejadores a mano. */
export class RecordingQueue implements JobQueue {
  sent: Array<{ name: QueueName; id: string; startAfterSeconds?: number }> = [];
  async send(name: QueueName, data: { id: string }, opts?: { startAfterSeconds?: number }) {
    this.sent.push({ name, id: data.id, startAfterSeconds: opts?.startAfterSeconds });
  }
  take(name: QueueName) {
    const out = this.sent.filter((s) => s.name === name);
    this.sent = this.sent.filter((s) => s.name !== name);
    return out;
  }
}

/** Envía avisos sin propagar errores: el barrido recupera lo que falle. */
export async function notify(
  queue: JobQueue,
  name: QueueName,
  id: string,
  log?: { warn: (o: object, m: string) => void },
  opts?: { startAfterSeconds?: number },
) {
  try {
    await queue.send(name, { id }, opts);
  } catch (err) {
    log?.warn({ err, name, id }, 'queue send failed; sweeper will recover');
  }
}
