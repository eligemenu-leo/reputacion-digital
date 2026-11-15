/**
 * Conexión de Meta: páginas de Facebook e Instagram profesional (Facebook Login).
 *
 *  1. POST /clients/:id/connections/meta/start → URL del diálogo de Facebook.
 *  2. Meta redirige a GET /oauth/meta/callback (sin sesión: el `state` de un
 *     solo uso identifica usuario, cliente y organización).
 *  3. La web lista las páginas y cuentas de Instagram autorizadas y el usuario
 *     elige cuáles conectar. Solo entonces se guardan (sellados) los tokens de
 *     esas páginas: el resto no se conserva.
 *  4. Webhooks: GET/POST /webhooks/meta, con firma verificada y deduplicación.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import {
  FACEBOOK_REPLY_SCOPE,
  FACEBOOK_REQUIRED_SCOPES,
  INSTAGRAM_REQUIRED_SCOPES,
  META_WEBHOOK_SCOPE,
  metaScopes,
  metaWebhookChallenge,
  parseMetaWebhook,
  verifyMetaSignature,
  type MetaPage,
} from '@rep/connectors';
import { AppError, uuidSchema } from '@rep/shared';
import { z } from 'zod';
import { requireAuth } from '../app';
import { elevate, withService, withUser, type Tx } from '../lib/db';
import { requireClientAction, requireOrgPermission } from '../lib/authz';
import { parse } from '../lib/http';
import type { AuthContext } from '../lib/auth';
import {
  loadCredential,
  providerUserRef,
  saveCredential,
  updateCredential,
  type StoredPage,
} from '../domain/credentials';
import { notify, QUEUES } from '../domain/queue';
import { enqueueSync } from '../domain/sync';
import { audit } from '../domain/workflow';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type CallbackError =
  | 'access_denied'
  | 'invalid_state'
  | 'exchange_failed'
  | 'missing_scope'
  | 'forbidden'
  | 'not_configured';

const connectSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            provider: z.enum(['facebook_page', 'instagram_business']),
            externalId: z.string().regex(/^\d{1,40}$/),
            clientId: uuidSchema,
            locationId: uuidSchema.nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/** Tareas de página con las que Meta permite leer comentarios y moderar. */
const READ_TASKS = ['MODERATE', 'MANAGE', 'CREATE_CONTENT'];

export interface MetaAsset {
  provider: 'facebook_page' | 'instagram_business';
  externalId: string;
  pageId: string;
  displayName: string;
  canRead: boolean;
  canReply: boolean;
  ineligibilityReason?: string;
}

/** Qué se puede hacer con cada página / cuenta según los permisos y el rol del usuario. */
export function assetsFor(pages: MetaPage[], scopes: string[]): MetaAsset[] {
  const has = (list: string[]) => list.every((s) => scopes.includes(s));
  const out: MetaAsset[] = [];
  for (const p of pages) {
    // Tareas desconocidas (página de un porfolio empresarial): Meta ya filtró el acceso al dar
    // el token de página; si el rol no basta, la API lo dirá al leer o publicar.
    const roleOk = p.tasks === null || p.tasks.some((t) => READ_TASKS.includes(t));
    const fbRead = roleOk && has(FACEBOOK_REQUIRED_SCOPES);
    const fbReply =
      fbRead &&
      scopes.includes(FACEBOOK_REPLY_SCOPE) &&
      (p.tasks === null || p.tasks.includes('MODERATE'));
    out.push({
      provider: 'facebook_page',
      externalId: p.id,
      pageId: p.id,
      displayName: p.name,
      canRead: fbRead,
      canReply: fbReply,
      ineligibilityReason: !roleOk
        ? 'Tu rol en la página no permite leer ni moderar comentarios'
        : !has(FACEBOOK_REQUIRED_SCOPES)
          ? 'No se concedió el permiso para leer los comentarios de la página'
          : !fbReply
            ? 'No se concedió el permiso para responder (o tu rol no permite moderar)'
            : undefined,
    });
    if (p.instagram) {
      const igRead = roleOk && has(INSTAGRAM_REQUIRED_SCOPES);
      out.push({
        provider: 'instagram_business',
        externalId: p.instagram.id,
        pageId: p.id,
        displayName: p.instagram.username ? `@${p.instagram.username}` : `Instagram de ${p.name}`,
        canRead: igRead,
        canReply: igRead,
        ineligibilityReason: igRead
          ? undefined
          : !roleOk
            ? 'Tu rol en la página vinculada no permite gestionar comentarios'
            : 'No se concedieron los permisos de Instagram',
      });
    }
  }
  return out;
}

export async function metaRoutes(app: FastifyInstance) {
  const { sql, config, integrations, queue } = app.deps;

  /** La autorización es de la organización: cada página se asigna después a su cliente (ADR-028). */
  app.post('/organizations/:orgId/connections/meta/start', async (req) => {
    const auth = requireAuth(req);
    const orgId = parse(uuidSchema, (req.params as { orgId: string }).orgId);
    const meta = integrations.meta;
    if (!meta || !integrations.box) {
      throw new AppError(
        'CONFLICT',
        'Facebook e Instagram no están configurados en este entorno (falta la app de Meta)',
      );
    }
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'connections.manage');
      const state = randomBytes(32).toString('base64url');
      const stateHash = sha256(state);
      await elevate(tx);
      await tx`
        insert into private.oauth_states
          (state_hash, provider, organization_id, client_id, user_id, code_verifier_sealed, redirect_uri)
        values (${stateHash}, 'meta', ${orgId}, null, ${auth.userId}, null, ${integrations.metaRedirectUri})`;
      return {
        authorizationUrl: meta
          .graph()
          .authorizationUrl(
            integrations.metaRedirectUri,
            state,
            metaScopes(Boolean(meta.webhookVerifyToken)),
          ),
      };
    });
  });

  app.get('/oauth/meta/callback', async (req, reply) => {
    const q = parse(
      z.object({
        state: z.string().max(200).optional(),
        code: z.string().max(2000).optional(),
        error: z.string().max(100).optional(),
        error_reason: z.string().max(100).optional(),
      }),
      req.query,
    );
    // Hasta saber la organización (por el state), la web resuelve /fuentes con la del usuario.
    let orgPath = '';
    const back = (r: FastifyReply, params: Record<string, string>) =>
      r.redirect(
        `${config.APP_URL.replace(/\/$/, '')}${orgPath}/fuentes?${new URLSearchParams(params)}`,
        303,
      );
    const failWith = (e: CallbackError) => back(reply, { meta_error: e });
    const meta = integrations.meta;
    const box = integrations.box;
    if (!meta || !box) return failWith('not_configured');
    if (!q.state) return failWith('invalid_state');

    const stateHash = sha256(q.state);
    const st = await withService(sql, null, async (tx) => {
      const [s] = await tx<{ organizationId: string; userId: string; redirectUri: string }[]>`
        update private.oauth_states set consumed_at = now()
         where state_hash = ${stateHash} and consumed_at is null and expires_at > now() and provider = 'meta'
        returning organization_id, user_id, redirect_uri`;
      return s ?? null;
    });
    if (!st) return failWith('invalid_state');
    orgPath = `/o/${st.organizationId}`;
    if (q.error || !q.code) {
      return failWith(
        q.error === 'access_denied' || q.error_reason === 'user_denied'
          ? 'access_denied'
          : 'exchange_failed',
      );
    }

    const graph = meta.graph();
    const creds = await graph.exchangeCode(q.code, st.redirectUri);
    if (!creds.ok) {
      req.log.warn(
        { kind: creds.error.kind, code: creds.error.providerCode },
        'meta oauth exchange failed',
      );
      return failWith('exchange_failed');
    }
    // Sin poder listar páginas ni leer su actividad no hay nada que conectar.
    const minimum = ['pages_show_list', 'pages_read_engagement'];
    if (!minimum.every((s) => creds.value.scopes.includes(s))) {
      return failWith('missing_scope');
    }
    const actor: AuthContext = { userId: st.userId, email: null, aal: 'aal1', sessionId: null };
    const metaUser = creds.value.meta?.userId;
    const credentialId = await withService(sql, actor, async (tx) => {
      const [p] = await tx<{ v: boolean }[]>`
        select private.has_org_permission(${st.organizationId}::uuid, 'connections.manage') as v`;
      if (!p?.v) return null;
      const id = await saveCredential(tx, box, {
        organizationId: st.organizationId,
        clientId: null,
        provider: 'meta',
        credentials: { ...creds.value, meta: undefined },
        userId: st.userId,
        pages: {},
        providerUserRef: metaUser
          ? providerUserRef(config.AUTHOR_REF_PEPPER, 'meta', metaUser)
          : null,
      });
      await audit(tx, {
        organizationId: st.organizationId,
        actor: { userId: st.userId, requestId: req.id },
        action: 'connection.oauth_authorized',
        entityType: 'provider_credentials',
        entityId: id,
        metadata: { provider: 'meta', scopes: creds.value.scopes },
      });
      return id;
    });
    if (!credentialId) return failWith('forbidden');
    return back(reply, { meta: credentialId });
  });

  async function ownCredential(tx: Tx, auth: AuthContext, id: string) {
    await elevate(tx);
    const [c] = await tx<
      {
        id: string;
        organizationId: string;
        authorizedBy: string | null;
        revokedAt: Date | null;
      }[]
    >`
      select id, organization_id, authorized_by, revoked_at from private.provider_credentials
       where id = ${id} and provider = 'meta'`;
    if (!c || c.authorizedBy !== auth.userId || c.revokedAt) {
      throw new AppError('NOT_FOUND', 'Autorización de Meta no encontrada o caducada');
    }
    await tx.unsafe('set local role authenticated');
    await requireOrgPermission(tx, auth, c.organizationId, 'connections.manage');
    return c;
  }

  /**
   * Autorizaciones de Meta vigentes del usuario en la organización: permiten
   * asignar más páginas después sin volver a pasar por Facebook.
   */
  app.get('/organizations/:orgId/meta/credentials', async (req) => {
    const auth = requireAuth(req);
    const orgId = parse(uuidSchema, (req.params as { orgId: string }).orgId);
    return withUser(sql, auth, async (tx) => {
      await requireOrgPermission(tx, auth, orgId, 'connections.manage');
      await elevate(tx);
      const items = await tx<{ id: string; authorizedAt: Date; sources: number }[]>`
        select c.id, c.authorized_at,
               (select count(*)::int from public.connected_accounts a
                 where a.credential_id = c.id and a.status <> 'disconnected') as sources
          from private.provider_credentials c
         where c.organization_id = ${orgId} and c.provider = 'meta' and c.authorized_by = ${auth.userId}
           and c.revoked_at is null
         order by c.authorized_at desc limit 10`;
      return { items };
    });
  });

  /** Lee en vivo las páginas de la autorización (con el token de usuario). */
  async function livePages(id: string) {
    const meta = integrations.meta;
    const box = integrations.box;
    if (!meta || !box) throw new AppError('CONFLICT', 'Meta no está configurado en este entorno');
    const loaded = await withService(sql, null, (tx) => loadCredential(tx, box, id));
    if (!loaded) throw new AppError('NOT_FOUND', 'Autorización de Meta no encontrada');
    const pages = await meta.graph().listPages(loaded.credentials.accessToken);
    if (!pages.ok) {
      throw new AppError('CONFLICT', `Meta: ${pages.error.message}`, { kind: pages.error.kind });
    }
    return { loaded, pages: pages.value };
  }

  app.get('/meta/credentials/:id/assets', async (req) => {
    const auth = requireAuth(req);
    const id = parse(uuidSchema, (req.params as { id: string }).id);
    const cred = await withUser(sql, auth, (tx) => ownCredential(tx, auth, id));
    const { loaded, pages } = await livePages(id);
    const { connected, clients } = await withUser(sql, auth, async (tx) => ({
      // En toda la organización: una página pertenece a un solo cliente.
      connected: await tx<
        { provider: string; externalAccountId: string; clientId: string; clientName: string }[]
      >`
        select a.provider, a.external_account_id, a.client_id, c.name as client_name
          from public.connected_accounts a join public.clients c on c.id = a.client_id
         where a.organization_id = ${cred.organizationId}
           and a.provider in ('facebook_page', 'instagram_business') and a.status <> 'disconnected'`,
      // Clientes a los que este usuario puede asignar fuentes.
      clients: await tx<{ id: string; name: string }[]>`
        select id, name from public.clients
         where organization_id = ${cred.organizationId} and archived_at is null
           and private.has_client_permission(id, 'connections.manage')
         order by name`,
    }));
    const already = new Map(
      connected.map((c) => [
        `${c.provider}:${c.externalAccountId}`,
        { clientId: c.clientId, clientName: c.clientName },
      ]),
    );
    return {
      organizationId: cred.organizationId,
      clients,
      missingScopes: metaScopes(Boolean(integrations.meta?.webhookVerifyToken)).filter(
        (s) => !loaded.credentials.scopes.includes(s),
      ),
      items: assetsFor(pages, loaded.credentials.scopes).map((a) => ({
        ...a,
        connectedTo: already.get(`${a.provider}:${a.externalId}`) ?? null,
      })),
    };
  });

  app.post('/meta/credentials/:id/connect', async (req, reply) => {
    const auth = requireAuth(req);
    const id = parse(uuidSchema, (req.params as { id: string }).id);
    const body = parse(connectSchema, req.body);
    const meta = integrations.meta!;
    await withUser(sql, auth, (tx) => ownCredential(tx, auth, id));
    const { loaded, pages } = await livePages(id);
    // No se confía en la web: cada elemento debe pertenecer a esta autorización y poder leerse.
    const assets = new Map(
      assetsFor(pages, loaded.credentials.scopes).map((a) => [`${a.provider}:${a.externalId}`, a]),
    );
    const picked = body.items.map((i) => ({
      item: i,
      asset: assets.get(`${i.provider}:${i.externalId}`),
    }));
    if (picked.some((p) => !p.asset)) {
      throw new AppError(
        'VALIDATION',
        'Alguna página o cuenta no pertenece a la autorización de Meta',
      );
    }
    if (picked.some((p) => !p.asset!.canRead)) {
      throw new AppError(
        'VALIDATION',
        'Alguna página o cuenta no se puede leer con los permisos concedidos',
      );
    }
    const keys = picked.map((p) => `${p.item.provider}:${p.item.externalId}`);
    if (new Set(keys).size !== keys.length) {
      throw new AppError('VALIDATION', 'Cada página o cuenta se asigna a un solo cliente');
    }
    // Cada cliente debe ser de la organización y el usuario debe poder gestionar sus fuentes.
    await withUser(sql, auth, async (tx) => {
      const cred = await ownCredential(tx, auth, id);
      for (const clientId of new Set(picked.map((p) => p.item.clientId))) {
        await requireClientAction(tx, clientId, 'connections.manage');
        const [c] = await tx<{ organizationId: string }[]>`
          select organization_id from public.clients where id = ${clientId}`;
        if (c?.organizationId !== cred.organizationId) {
          throw new AppError('NOT_FOUND', 'Cliente no encontrado');
        }
      }
      const taken = await tx<
        { provider: string; externalAccountId: string; clientId: string; name: string }[]
      >`
        select a.provider, a.external_account_id, a.client_id, c.name from public.connected_accounts a
          join public.clients c on c.id = a.client_id
         where a.organization_id = ${cred.organizationId} and a.status <> 'disconnected'
           and a.provider || ':' || a.external_account_id = any(${keys})`;
      // Volver a conectar al mismo cliente (p. ej. tras caducar) sí se permite.
      const clash = taken.find(
        (t) =>
          picked.find(
            (p) =>
              `${p.item.provider}:${p.item.externalId}` === `${t.provider}:${t.externalAccountId}`,
          )!.item.clientId !== t.clientId,
      );
      if (clash) {
        throw new AppError(
          'CONFLICT',
          `«${assets.get(`${clash.provider}:${clash.externalAccountId}`)!.displayName}» ya está conectada al cliente «${clash.name}». Desconéctala allí para asignarla a otro.`,
        );
      }
    });
    const pageById = new Map(pages.map((p) => [p.id, p]));
    const pageIds = [...new Set(picked.map((p) => p.asset!.pageId))];

    // Avisos en tiempo real (si el webhook está configurado). Si falla, se sincroniza por sondeo.
    const webhooks = new Map<string, boolean>();
    for (const pid of pageIds) {
      if (!meta.webhookVerifyToken || !loaded.credentials.scopes.includes(META_WEBHOOK_SCOPE)) {
        webhooks.set(pid, false);
        continue;
      }
      const r = await meta
        .graph()
        .subscribePage({ id: pid, accessToken: pageById.get(pid)!.accessToken });
      if (!r.ok)
        req.log.warn({ kind: r.error.kind, code: r.error.providerCode }, 'meta subscribe failed');
      webhooks.set(pid, r.ok);
    }

    const result = await withUser(sql, auth, async (tx) => {
      const cred = await ownCredential(tx, auth, id);
      await elevate(tx);
      // Solo se guardan los tokens de las páginas elegidas (más las que ya usaba esta autorización).
      const current = await loadCredential(tx, integrations.box!, id, { forUpdate: true });
      const stored: Record<string, StoredPage> = { ...current!.pages };
      for (const pid of pageIds) {
        const p = pageById.get(pid)!;
        stored[pid] = {
          token: p.accessToken,
          name: p.name,
          tasks: p.tasks,
          instagramId: p.instagram?.id,
        };
      }
      await updateCredential(tx, integrations.box!, id, current!.credentials, stored);

      const created: { id: string; runId: string | null }[] = [];
      for (const { item, asset } of picked) {
        const a = asset!;
        const hook = webhooks.get(a.pageId) ?? false;
        const caps = [
          'fetch_interactions',
          'fetch_interaction',
          'read_existing_replies',
          'publication_status',
          ...(a.canReply ? ['publish_reply'] : []),
          ...(hook ? ['webhooks'] : []),
        ];
        const cfg = {
          pageId: a.pageId,
          canReply: a.canReply,
          ineligibilityReason: a.canReply ? null : (a.ineligibilityReason ?? null),
          webhooks: hook,
        };
        const [row] = await tx<{ id: string }[]>`
          insert into public.connected_accounts
            (organization_id, client_id, location_id, provider, external_account_id, display_name, status, credential_id,
             granted_scopes, capabilities, config, authorized_at, authorized_by, next_run_at)
          values (${cred.organizationId}, ${item.clientId}, ${item.locationId}, ${a.provider},
                  ${a.externalId}, ${a.displayName.slice(0, 200)}, 'connected', ${id}, ${current!.credentials.scopes},
                  ${caps}, ${tx.json(cfg)}, now(), ${auth.userId}, now())
          on conflict on constraint connected_accounts_unique do update set
            status = 'connected', credential_id = excluded.credential_id, granted_scopes = excluded.granted_scopes,
            capabilities = excluded.capabilities, config = excluded.config, display_name = excluded.display_name,
            location_id = coalesce(excluded.location_id, public.connected_accounts.location_id),
            authorized_at = now(), authorized_by = excluded.authorized_by, disconnected_at = null,
            last_error_kind = null, last_error_message = null, next_run_at = now()
          returning id`;
        const run = await enqueueSync(tx, row!.id, 'manual', auth.userId);
        await audit(tx, {
          organizationId: cred.organizationId,
          clientId: item.clientId,
          actor: { userId: auth.userId, requestId: req.id },
          action: 'connection.connect',
          entityType: 'connected_accounts',
          entityId: row!.id,
          metadata: { provider: a.provider, canReply: a.canReply, webhooks: hook },
        });
        created.push({ id: row!.id, runId: run.created ? run.runId : null });
      }
      return created;
    });
    for (const c of result) if (c.runId) await notify(queue, QUEUES.sync, c.runId, req.log);
    return reply.status(201).send({ items: result });
  });

  // ------------------------------------------------------------- Webhooks
  await app.register(async (hooks) => {
    // El cuerpo se conserva tal cual llega: la firma se calcula sobre esos bytes.
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    hooks.get('/webhooks/meta', async (req, reply) => {
      const token = integrations.meta?.webhookVerifyToken;
      if (!token) return reply.status(404).send();
      const challenge = metaWebhookChallenge(
        req.query as Record<string, string | undefined>,
        token,
      );
      if (!challenge) return reply.status(403).send();
      return reply.type('text/plain').send(challenge);
    });

    hooks.post('/webhooks/meta', async (req, reply) => {
      const meta = integrations.meta;
      if (!meta?.webhookVerifyToken) return reply.status(404).send();
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers['x-hub-signature-256'];
      if (!verifyMetaSignature(raw, typeof sig === 'string' ? sig : undefined, meta.appSecret)) {
        req.log.warn('meta webhook: firma no válida');
        return reply.status(401).send();
      }
      const parsed = parseMetaWebhook(raw);
      if (!parsed.ok) return reply.status(400).send();
      const runIds = await withService(sql, null, async (tx) => {
        const ids: string[] = [];
        for (const e of parsed.value) {
          const [fresh] = await tx`
            insert into private.webhook_events (provider, event_id, account_external_id, interaction_external_id, event_type)
            values (${e.provider}, ${e.eventId}, ${e.accountExternalId}, ${e.interactionExternalId ?? null}, ${e.type})
            on conflict do nothing returning event_id`;
          if (!fresh) continue; // reintento de Meta: ya procesado
          const accounts = await tx<{ id: string }[]>`
            select id from public.connected_accounts
             where provider = ${e.provider} and external_account_id = ${e.accountExternalId}
               and status in ('connected', 'syncing', 'temporary_error')`;
          for (const a of accounts) {
            const r = await enqueueSync(tx, a.id, 'webhook', null);
            if (r.created) ids.push(r.runId);
            // Si ya había una sincronización en curso, se adelanta la siguiente para no perder el aviso.
            else
              await tx`update public.connected_accounts set next_run_at = least(coalesce(next_run_at, now()), now() + interval '1 minute') where id = ${a.id}`;
          }
          await tx`update private.webhook_events set matched_accounts = ${accounts.length}
                    where provider = ${e.provider} and event_id = ${e.eventId}`;
        }
        return ids;
      });
      for (const id of runIds) await notify(queue, QUEUES.sync, id, req.log);
      // Meta solo necesita un 200; el contenido se lee de la API al sincronizar.
      return reply.status(200).send({ ok: true });
    });
  });
}
