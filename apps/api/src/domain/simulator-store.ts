import type { SimulatorItem, SimulatorStore } from '@rep/connectors';
import { withService, type Sql } from '../lib/db';

/** «Lado remoto» del simulador guardado en el esquema `private` (inaccesible para usuarios). */
export class DbSimulatorStore implements SimulatorStore {
  constructor(private readonly sql: Sql) {}

  async listItems(accountId: string, since: Date | undefined, offset: number, limit: number) {
    return withService(this.sql, null, async (tx) => {
      const rows = await tx<
        Array<{
          externalId: string;
          authorName: string;
          authorId: string;
          content: string | null;
          rating: number | null;
          createdAt: Date;
          updatedAt: Date;
        }>
      >`
        select external_id, author_name, author_id, content, rating, created_at, updated_at
          from private.simulator_items
         where connected_account_id = ${accountId}
           and (${since ?? null}::timestamptz is null or updated_at >= ${since ?? null}::timestamptz)
         order by created_at, external_id
         offset ${offset} limit ${limit}`;
      return rows.map((r): SimulatorItem => ({ ...r }));
    });
  }

  async addItems(accountId: string, items: Omit<SimulatorItem, 'updatedAt'>[]) {
    if (!items.length) return;
    await withService(this.sql, null, async (tx) => {
      for (const i of items) {
        await tx`
          insert into private.simulator_items (connected_account_id, external_id, author_name, author_id, content, rating, created_at)
          values (${accountId}, ${i.externalId}, ${i.authorName}, ${i.authorId}, ${i.content}, ${i.rating}, ${i.createdAt})
          on conflict (connected_account_id, external_id) do nothing`;
      }
    });
  }

  /** Simula que el autor edita su reseña en el proveedor. */
  async editItem(accountId: string, externalId: string, content: string, rating: number | null) {
    return withService(this.sql, null, async (tx) => {
      const r = await tx`
        update private.simulator_items set content = ${content}, rating = ${rating}, updated_at = now()
         where connected_account_id = ${accountId} and external_id = ${externalId} returning 1`;
      return r.length > 0;
    });
  }

  async count(accountId: string): Promise<number> {
    return withService(this.sql, null, async (tx) => {
      const [r] = await tx<{ n: number }[]>`
        select count(*)::int as n from private.simulator_items where connected_account_id = ${accountId}`;
      return r?.n ?? 0;
    });
  }

  async getReply(accountId: string, interactionExternalId: string) {
    return withService(this.sql, null, async (tx) => {
      const [r] = await tx<{ replyId: string; content: string; publishedAt: Date }[]>`
        select reply_id, reply_content as content, published_at from private.simulator_remote
         where connected_account_id = ${accountId} and interaction_external_id = ${interactionExternalId}`;
      return r ?? null;
    });
  }

  async putReply(
    accountId: string,
    interactionExternalId: string,
    replyId: string,
    content: string,
  ) {
    await withService(this.sql, null, async (tx) => {
      // Un proveedor real con una sola respuesta por reseña: publicar de nuevo la sustituye,
      // nunca crea un duplicado.
      await tx`
        insert into private.simulator_remote (connected_account_id, interaction_external_id, reply_id, reply_content)
        values (${accountId}, ${interactionExternalId}, ${replyId}, ${content})
        on conflict (connected_account_id, interaction_external_id)
        do update set reply_id = excluded.reply_id, reply_content = excluded.reply_content, published_at = now()`;
    });
  }
}
