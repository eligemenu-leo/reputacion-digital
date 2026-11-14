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
  if (!taken.creds || !integrations.google) return { released: true, revokedAtProvider: false };
  const r = await integrations.google().disconnect(taken.creds.credentials);
  return { released: true, revokedAtProvider: r.ok };
}

/** Limpieza periódica (barrido del worker). */
export async function sweepCredentials(
  sql: Sql,
  integrations: Integrations,
  olderThanMinutes = 60,
) {
  const ids = await withService(sql, null, async (tx) => {
    await tx`delete from private.oauth_states where expires_at < now() - interval '1 day'`;
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
