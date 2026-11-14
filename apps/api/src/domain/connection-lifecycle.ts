/**
 * Ciclo de vida de credenciales: revocación al desconectar y limpieza de
 * autorizaciones abandonadas (el usuario autorizó en Google pero no eligió
 * ninguna ubicación). Una credencial sin uso no se conserva.
 */
import { withService, type Sql } from '../lib/db';
import { loadCredential, type Integrations } from './credentials';

/**
 * Si ninguna fuente activa usa la credencial, se revoca en el proveedor y se
 * borra. Devuelve si Google confirmó la revocación (null = seguía en uso).
 */
export async function releaseCredential(
  sql: Sql,
  integrations: Integrations,
  credentialId: string,
): Promise<{ released: boolean; revokedAtProvider: boolean | null }> {
  const box = integrations.box;
  const taken = await withService(sql, null, async (tx) => {
    const [inUse] = await tx`
      select 1 from public.connected_accounts where credential_id = ${credentialId} and status <> 'disconnected' limit 1`;
    if (inUse) return null;
    if (!box) return { creds: null };
    const loaded = await loadCredential(tx, box, credentialId, { forUpdate: true }).catch(
      () => null,
    );
    // Se borra antes de llamar a Google: aunque la revocación falle, el token deja de estar guardado.
    await tx`update public.connected_accounts set credential_id = null where credential_id = ${credentialId}`;
    await tx`delete from private.provider_credentials where id = ${credentialId}`;
    return { creds: loaded };
  });
  if (!taken) return { released: false, revokedAtProvider: null };
  if (!taken.creds) return { released: true, revokedAtProvider: false };
  if (taken.creds.row.provider === 'meta') {
    return { released: true, revokedAtProvider: await releaseMeta(sql, integrations, taken.creds) };
  }
  if (!integrations.google) return { released: true, revokedAtProvider: false };
  const r = await integrations.google().disconnect(taken.creds.credentials);
  return { released: true, revokedAtProvider: r.ok };
}

/**
 * Meta: se dejan de recibir avisos de las páginas que ya no usa ninguna fuente
 * y se revoca la app solo si ninguna otra autorización vigente depende del
 * mismo usuario de Facebook (revocar invalida todos sus tokens de página).
 */
async function releaseMeta(
  sql: Sql,
  integrations: Integrations,
  creds: NonNullable<Awaited<ReturnType<typeof loadCredential>>>,
): Promise<boolean> {
  const meta = integrations.meta;
  if (!meta) return false;
  const graph = meta.graph();
  const pageIds = Object.keys(creds.pages);
  const { stillUsed, otherCredential } = await withService(sql, null, async (tx) => {
    const used = await tx<{ pageId: string }[]>`
      select distinct config->>'pageId' as page_id from public.connected_accounts
       where provider in ('facebook_page', 'instagram_business') and status <> 'disconnected'
         and config->>'pageId' = any(${pageIds})`;
    const [other] = creds.row.providerUserRef
      ? await tx`
          select 1 from private.provider_credentials
           where provider = 'meta' and provider_user_ref = ${creds.row.providerUserRef} and id <> ${creds.row.id}
             and revoked_at is null limit 1`
      : [];
    return { stillUsed: new Set(used.map((u) => u.pageId)), otherCredential: Boolean(other) };
  });
  for (const id of pageIds) {
    if (stillUsed.has(id)) continue;
    await graph.unsubscribePage({ id, accessToken: creds.pages[id]!.token });
  }
  if (otherCredential) return false;
  return (await graph.revoke(creds.credentials.accessToken)).ok;
}

/** Limpieza periódica (barrido del worker). */
export async function sweepCredentials(
  sql: Sql,
  integrations: Integrations,
  olderThanMinutes = 60,
) {
  const ids = await withService(sql, null, async (tx) => {
    await tx`delete from private.oauth_states where expires_at < now() - interval '1 day'`;
    await tx`delete from private.webhook_events where received_at < now() - interval '7 days'`;
    const rows = await tx<{ id: string }[]>`
      select c.id from private.provider_credentials c
       where c.created_at < now() - make_interval(mins => ${olderThanMinutes})
         and not exists (select 1 from public.connected_accounts a where a.credential_id = c.id and a.status <> 'disconnected')
       limit 20`;
    return rows.map((r) => r.id);
  });
  let n = 0;
  for (const id of ids) if ((await releaseCredential(sql, integrations, id)).released) n++;
  return n;
}
