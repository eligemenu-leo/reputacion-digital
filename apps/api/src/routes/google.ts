/**
 * Conexión de Google Business Profile (OAuth 2.0 + PKCE).
 *
 *  1. POST /clients/:id/connections/google/start → URL de autorización de Google.
 *  2. Google redirige a GET /oauth/google/callback (sin sesión: el `state` de un
 *     solo uso identifica al usuario, cliente y organización).
 *  3. La web lista las ubicaciones autorizadas y el usuario elige cuáles conectar.
 *
 * Los tokens se sellan antes de guardarse y nunca salen de la API ni del worker.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { GOOGLE_SCOPE, type ExternalLocation } from '@rep/connectors';
import { AppError, uuidSchema } from '@rep/shared';
import { z } from 'zod';
import { requireAuth } from '../app';
import { elevate, withService, withUser, type Tx } from '../lib/db';
import { requireClientAction } from '../lib/authz';
import { parse } from '../lib/http';
import type { AuthContext } from '../lib/auth';
import { saveCredential } from '../domain/credentials';
import { useCredential } from '../domain/connectors';
import { notify, QUEUES } from '../domain/queue';
import { enqueueSync } from '../domain/sync';
import { audit } from '../domain/workflow';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const connectSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            externalLocationId: z.string().regex(/^accounts\/[\w-]+\/locations\/[\w-]+$/),
            locationId: uuidSchema.nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/** Errores que la web traduce a mensajes claros (no se pasa texto libre en la URL). */
type CallbackError =
  | 'access_denied'
  | 'invalid_state'
  | 'exchange_failed'
  | 'missing_scope'
  | 'forbidden'
  | 'not_configured';

export async function googleRoutes(app: FastifyInstance) {
  const { sql, config, integrations, queue } = app.deps;

  app.get('/integrations', async (req) => {
    requireAuth(req);
    return {
      google: {
        configured: Boolean(integrations.google),
        // Datos que Leo debe registrar en Google Cloud; no son secretos.
        redirectUri: integrations.googleRedirectUri,
        scope: GOOGLE_SCOPE,
        missing: [
          ...(config.GOOGLE_OAUTH_CLIENT_ID
            ? []
            : ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']),
          ...(config.CREDENTIALS_ENCRYPTION_KEYS ? [] : ['CREDENTIALS_ENCRYPTION_KEYS']),
        ],
      },
      facebook: { configured: false, missing: ['Fase 4 · bloque 2'] },
      instagram: { configured: false, missing: ['Fase 4 · bloque 2'] },
    };
  });

  app.post('/clients/:clientId/connections/google/start', async (req) => {
    const auth = requireAuth(req);
    const clientId = parse(uuidSchema, (req.params as { clientId: string }).clientId);
    const make = integrations.google;
    const box = integrations.box;
    if (!make || !box) {
      throw new AppError(
        'CONFLICT',
        'Google Business Profile no está configurado en este entorno (falta el cliente OAuth de Google)',
      );
    }
    return withUser(sql, auth, async (tx) => {
      await requireClientAction(tx, clientId, 'connections.manage');
      const [c] = await tx<{ organizationId: string }[]>`
        select organization_id from public.clients where id = ${clientId}`;
      const state = randomBytes(32).toString('base64url');
      const stateHash = sha256(state);
      const start = await make().connect({ redirectUri: integrations.googleRedirectUri, state });
      if (!start.ok) throw new AppError('INTERNAL', start.error.message);
      await elevate(tx);
      await tx`delete from private.oauth_states where expires_at < now() - interval '1 day'`;
      await tx`
        insert into private.oauth_states
          (state_hash, provider, organization_id, client_id, user_id, code_verifier_sealed, redirect_uri)
        values (${stateHash}, 'google_business_profile', ${c!.organizationId}, ${clientId}, ${auth.userId},
                ${box.seal(start.value.codeVerifier!, stateHash)}, ${integrations.googleRedirectUri})`;
      return { authorizationUrl: start.value.authorizationUrl };
    });
  });

  app.get('/oauth/google/callback', async (req, reply) => {
    const q = parse(
      z.object({
        state: z.string().max(200).optional(),
        code: z.string().max(2000).optional(),
        error: z.string().max(100).optional(),
        scope: z.string().max(2000).optional(),
      }),
      req.query,
    );
    const back = (r: FastifyReply, params: Record<string, string>) =>
      r.redirect(
        `${config.APP_URL.replace(/\/$/, '')}/fuentes?${new URLSearchParams(params)}`,
        303,
      );
    const failWith = (e: CallbackError) => back(reply, { google_error: e });
    const make = integrations.google;
    const box = integrations.box;
    if (!make || !box) return failWith('not_configured');
    if (!q.state) return failWith('invalid_state');

    // Un solo uso: el estado se consume de forma atómica, aunque luego falle el canje.
    const stateHash = sha256(q.state);
    const st = await withService(sql, null, async (tx) => {
      const [s] = await tx<
        {
          organizationId: string;
          clientId: string;
          userId: string;
          codeVerifierSealed: string;
          redirectUri: string;
        }[]
      >`
        update private.oauth_states set consumed_at = now()
         where state_hash = ${stateHash} and consumed_at is null and expires_at > now()
           and provider = 'google_business_profile'
        returning organization_id, client_id, user_id, code_verifier_sealed, redirect_uri`;
      return s ?? null;
    });
    if (!st) return failWith('invalid_state');
    if (q.error || !q.code)
      return failWith(q.error === 'access_denied' ? 'access_denied' : 'exchange_failed');

    const connector = make();
    const creds = await connector.completeConnect({
      code: q.code,
      redirectUri: st.redirectUri,
      codeVerifier: box.open(st.codeVerifierSealed, stateHash),
    });
    if (!creds.ok) {
      req.log.warn(
        { kind: creds.error.kind, code: creds.error.providerCode },
        'google oauth exchange failed',
      );
      return failWith('exchange_failed');
    }
    if (!creds.value.scopes.includes(GOOGLE_SCOPE)) {
      await connector.disconnect(creds.value);
      return failWith('missing_scope');
    }
    const actor: AuthContext = { userId: st.userId, email: null, aal: 'aal1', sessionId: null };
    const credentialId = await withService(sql, actor, async (tx) => {
      // El permiso se vuelve a comprobar: pudo retirarse mientras el usuario estaba en Google.
      const [p] = await tx<{ v: boolean }[]>`
        select private.has_client_permission(${st.clientId}::uuid, 'connections.manage') as v`;
      if (!p?.v) return null;
      const id = await saveCredential(tx, box, {
        organizationId: st.organizationId,
        clientId: st.clientId,
        provider: 'google_business_profile',
        credentials: creds.value,
        userId: st.userId,
      });
      await audit(tx, {
        organizationId: st.organizationId,
        clientId: st.clientId,
        actor: { userId: st.userId, requestId: req.id },
        action: 'connection.oauth_authorized',
        entityType: 'provider_credentials',
        entityId: id,
        metadata: { provider: 'google_business_profile', scopes: creds.value.scopes },
      });
      return id;
    });
    if (!credentialId) {
      await connector.disconnect(creds.value);
      return failWith('forbidden');
    }
    return back(reply, { google: credentialId, client: st.clientId });
  });

  /** Solo quien autorizó puede elegir ubicaciones con esa autorización. */
  async function ownCredential(tx: Tx, auth: AuthContext, id: string) {
    await elevate(tx);
    const [c] = await tx<
      {
        id: string;
        organizationId: string;
        clientId: string;
        authorizedBy: string | null;
        revokedAt: Date | null;
      }[]
    >`
      select id, organization_id, client_id, authorized_by, revoked_at from private.provider_credentials
       where id = ${id} and provider = 'google_business_profile'`;
    if (!c || c.authorizedBy !== auth.userId || c.revokedAt) {
      throw new AppError('NOT_FOUND', 'Autorización de Google no encontrada o caducada');
    }
    await tx.unsafe('set local role authenticated');
    await requireClientAction(tx, c.clientId, 'connections.manage');
    return c;
  }

  async function listGoogleLocations(credentialId: string) {
    const r = await useCredential(sql, integrations, credentialId);
    if ('error' in r)
      throw new AppError('CONFLICT', `Google: ${r.error.message}`, { kind: r.error.kind });
    const accounts = await r.connector.listAccounts(r.credentials);
    if (!accounts.ok) {
      throw new AppError('CONFLICT', `Google: ${accounts.error.message}`, {
        kind: accounts.error.kind,
      });
    }
    const out: {
      account: { externalId: string; displayName: string };
      locations: ExternalLocation[];
    }[] = [];
    for (const a of accounts.value) {
      const locs = await r.connector.listLocations(r.credentials, a.externalId);
      if (!locs.ok) {
        throw new AppError('CONFLICT', `Google: ${locs.error.message}`, { kind: locs.error.kind });
      }
      out.push({
        account: { externalId: a.externalId, displayName: a.displayName },
        locations: locs.value,
      });
    }
    return out;
  }

  app.get('/google/credentials/:id/locations', async (req) => {
    const auth = requireAuth(req);
    const id = parse(uuidSchema, (req.params as { id: string }).id);
    const cred = await withUser(sql, auth, (tx) => ownCredential(tx, auth, id));
    const groups = await listGoogleLocations(id);
    const connected = await withUser(
      sql,
      auth,
      (tx) =>
        tx<{ externalAccountId: string }[]>`
        select external_account_id from public.connected_accounts
         where client_id = ${cred.clientId} and provider = 'google_business_profile' and status <> 'disconnected'`,
    );
    const already = new Set(connected.map((c) => c.externalAccountId));
    return {
      clientId: cred.clientId,
      accounts: groups.map((g) => ({
        ...g.account,
        locations: g.locations.map((l) => ({ ...l, alreadyConnected: already.has(l.externalId) })),
      })),
    };
  });

  app.post('/google/credentials/:id/connect', async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(uuidSchema, (req.params as { id: string }).id);
    const body = parse(connectSchema, req.body);
    await withUser(sql, auth, (tx) => ownCredential(tx, auth, id));
    // No se confía en la web: cada ubicación debe pertenecer a esta autorización.
    const byId = new Map(
      (await listGoogleLocations(id)).flatMap((g) =>
        g.locations.map((l) => [l.externalId, l] as const),
      ),
    );
    const unknown = body.items.filter((i) => !byId.has(i.externalLocationId));
    if (unknown.length) {
      throw new AppError(
        'VALIDATION',
        'Alguna ubicación no pertenece a la cuenta de Google autorizada',
      );
    }
    const result = await withUser(sql, auth, async (tx) => {
      const cred = await ownCredential(tx, auth, id);
      await elevate(tx);
      const [scopes] = await tx<{ scopes: string[] }[]>`
        select scopes from private.provider_credentials where id = ${id}`;
      const created: { id: string; runId: string | null }[] = [];
      for (const item of body.items) {
        const l = byId.get(item.externalLocationId)!;
        const caps = [
          'list_locations',
          'fetch_interactions',
          'fetch_interaction',
          'read_existing_replies',
          'publication_status',
          ...(l.canReply ? ['publish_reply', 'update_reply'] : []),
        ];
        const cfg = {
          accountExternalId: l.accountExternalId,
          canReply: l.canReply,
          ineligibilityReason: l.ineligibilityReason ?? null,
          address: l.address ?? null,
        };
        const [a] = await tx<{ id: string }[]>`
          insert into public.connected_accounts
            (organization_id, client_id, location_id, provider, external_account_id, display_name, status, credential_id,
             granted_scopes, capabilities, config, authorized_at, authorized_by, next_run_at)
          values (${cred.organizationId}, ${cred.clientId}, ${item.locationId}, 'google_business_profile',
                  ${l.externalId}, ${l.displayName.slice(0, 200)}, 'connected', ${id}, ${scopes!.scopes}, ${caps},
                  ${tx.json(cfg)}, now(), ${auth.userId}, now())
          on conflict on constraint connected_accounts_unique do update set
            status = 'connected', credential_id = excluded.credential_id, granted_scopes = excluded.granted_scopes,
            capabilities = excluded.capabilities, config = excluded.config, display_name = excluded.display_name,
            location_id = coalesce(excluded.location_id, public.connected_accounts.location_id),
            authorized_at = now(), authorized_by = excluded.authorized_by, disconnected_at = null,
            last_error_kind = null, last_error_message = null, next_run_at = now()
          returning id`;
        const run = await enqueueSync(tx, a!.id, 'manual', auth.userId);
        await audit(tx, {
          organizationId: cred.organizationId,
          clientId: cred.clientId,
          actor: { userId: auth.userId, requestId: req.id },
          action: 'connection.connect',
          entityType: 'connected_accounts',
          entityId: a!.id,
          metadata: { provider: 'google_business_profile', canReply: l.canReply },
        });
        created.push({ id: a!.id, runId: run.created ? run.runId : null });
      }
      return created;
    });
    for (const c of result) if (c.runId) await notify(queue, QUEUES.sync, c.runId, req.log);
    return reply.status(201).send({ items: result });
  });
}
