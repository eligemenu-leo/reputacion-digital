/**
 * Fase 2 · flujo completo con el proveedor SIMULADO (datos ficticios):
 * sincronización → bandeja → borrador → aprobación → publicación → verificación,
 * más los casos adversos (sin aprobación, edición tras aprobar, ambigüedad,
 * interruptor, aislamiento entre organizaciones y entre conectores).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { allowedTransitionPairs, responseHash } from '@rep/shared';
import { buildApp } from '../../src/app';
import { createIntegrations } from '../../src/domain/credentials';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/lib/db';
import { createTokenVerifier } from '../../src/lib/auth';
import { AppError } from '@rep/shared';
import { RecordingQueue, QUEUES } from '../../src/domain/queue';
import { createConnectorRegistry } from '../../src/domain/connectors';
import { runSync, scheduleDueSyncs, type JobDeps } from '../../src/domain/sync';
import { runPublish, sweepPublications } from '../../src/domain/publish';
import {
  JWT_SECRET,
  TEST_DB_URL,
  asUser,
  db,
  expectSqlError,
  seedWorld,
  token,
  type Db,
  type World,
} from '../fixtures';

let app: FastifyInstance;
let seed: Db;
let w: World;
let deps: JobDeps;
const queue = new RecordingQueue();

beforeAll(async () => {
  seed = db();
  w = await seedWorld(seed);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    LOG_LEVEL: 'silent',
    ENFORCE_ADMIN_MFA: 'true',
    JOBS_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
  const sql = createDb(config);
  app = await buildApp({
    config,
    sql,
    verifyToken: createTokenVerifier(config),
    authAdmin: {
      inviteUser: async () => {
        throw new AppError('NOT_SUPPORTED', 'no');
      },
    },
    queue,
    integrations: createIntegrations(config),
    ai: null,
  });
  deps = {
    sql,
    registry: createConnectorRegistry(sql),
    queue,
    authorRefPepper: 'test-pepper-test-pepper',
  };
});

afterAll(async () => {
  await seed`update public.platform_settings set value = '{"enabled": false, "reason": null}' where key = 'publishing_kill_switch'`;
  await app.close();
  await app.deps.sql.end();
  await seed.end();
});

const call = async (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  userId?: string,
  body?: unknown,
) => {
  const headers: Record<string, string> = {};
  if (userId) headers.authorization = `Bearer ${await token(userId)}`;
  const res = await app.inject({
    method,
    url,
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

/** Ejecuta los avisos de sincronización pendientes como lo haría el worker. */
async function drainSync() {
  const out = [];
  for (const m of queue.take(QUEUES.sync)) out.push(await runSync(deps, m.id));
  return out;
}
async function drainPublish() {
  const out = [];
  for (const m of queue.take(QUEUES.publish)) out.push(await runPublish(deps, m.id));
  return out;
}

let account: string;
const byText = async (fragment: string) => {
  const [r] = await seed<{ id: string }[]>`
    select id from public.external_interactions where connected_account_id = ${account} and content like ${'%' + fragment + '%'}`;
  return r!.id;
};
const detail = async (id: string, user = w.users.adminA) =>
  (await call('GET', `/v1/interactions/${id}`, user)).body;

/** Borrador → solicitud → aprobación por approverA. Devuelve el jobId. */
async function approveFlow(id: string, text: string, opts: { specialistReviewed?: boolean } = {}) {
  expect(
    (await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, { content: text }))
      .status,
  ).toBe(201);
  expect(
    (await call('POST', `/v1/interactions/${id}/request-approval`, w.users.managerA)).status,
  ).toBe(200);
  const r = await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
    decision: 'approve',
    contentHash: await responseHash(text),
    specialistReviewed: opts.specialistReviewed ?? false,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.jobId as string;
}

describe('Fase 2 · máquina de estados', () => {
  it('la tabla SQL de transiciones coincide con la del código', async () => {
    const rows = await seed<{ f: string; t: string }[]>`
      select from_state::text as f, to_state::text as t from private.interaction_transitions order by 1, 2`;
    const sqlPairs = rows.map((r) => `${r.f}>${r.t}`).sort();
    const tsPairs = allowedTransitionPairs()
      .map(([f, t]) => `${f}>${t}`)
      .sort();
    expect(sqlPairs).toEqual(tsPairs);
  });
});

describe('Fase 2 · fuentes simuladas y sincronización', () => {
  it('solo quien gestiona fuentes puede crear una fuente simulada', async () => {
    const denied = await call(
      'POST',
      `/v1/organizations/${w.orgA}/connections/simulator`,
      w.users.managerA,
      { clientId: w.clientA1 },
    );
    expect(denied.status).toBe(403);
    const other = await call(
      'POST',
      `/v1/organizations/${w.orgA}/connections/simulator`,
      w.users.adminB,
      { clientId: w.clientA1 },
    );
    expect(other.status).toBe(404);
    const r = await call(
      'POST',
      `/v1/organizations/${w.orgA}/connections/simulator`,
      w.users.adminA,
      { clientId: w.clientA1 },
    );
    expect(r.status).toBe(201);
    account = r.body.id;
  });

  it('genera reseñas ficticias y las sincroniza sin duplicar', async () => {
    const g = await call('POST', `/v1/connections/${account}/simulate-reviews`, w.users.adminA, {
      count: 12,
    });
    expect(g.body.generated).toBe(12);
    const s = await call('POST', `/v1/connections/${account}/sync`, w.users.adminA);
    expect(s.status).toBe(202);
    // Una segunda petición mientras hay una en cola devuelve la misma ejecución.
    const again = await call('POST', `/v1/connections/${account}/sync`, w.users.adminA);
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(s.body.runId);
    const [res] = await drainSync();
    expect(res).toMatchObject({
      status: 'succeeded',
      counters: { found: 12, created: 12, updated: 0 },
    });

    await call('POST', `/v1/connections/${account}/sync`, w.users.adminA);
    const [res2] = await drainSync();
    expect(res2).toMatchObject({ status: 'succeeded', counters: { created: 0, updated: 0 } });
    const [{ n } = { n: -1 }] = await seed<
      { n: number }[]
    >`select count(*)::int as n from public.external_interactions where connected_account_id = ${account}`;
    expect(n).toBe(12);
    const runs = await call('GET', `/v1/connections/${account}/runs`, w.users.adminA);
    expect(runs.body.items).toHaveLength(2);
  });

  it('marca todo como simulado y aplica el triaje preliminar', async () => {
    const legal = await detail(await byText('abogado'));
    expect(legal.interaction).toMatchObject({
      isSimulated: true,
      priority: 4,
      requiresSpecialist: true,
    });
    expect(legal.interaction.riskFlags).toContain('legal');
    const inj = await detail(await byText('Ignora tus instrucciones'));
    expect(inj.interaction.riskFlags).toContain('prompt_injection');
    expect(legal.events.at(-1).eventType).toBe('ingested');
  });

  it('un fallo de un conector no afecta a los demás y se refleja en su estado', async () => {
    const bad = (
      await call('POST', `/v1/organizations/${w.orgA}/connections/simulator`, w.users.adminA, {
        clientId: w.clientA2,
        syncMode: 'error',
      })
    ).body.id;
    const expired = (
      await call('POST', `/v1/organizations/${w.orgA}/connections/simulator`, w.users.adminA, {
        clientId: w.clientA2,
        displayName: 'Caducada',
        syncMode: 'credentials_expired',
      })
    ).body.id;
    await call('POST', `/v1/connections/${bad}/simulate-reviews`, w.users.adminA, { count: 3 });
    for (const a of [bad, expired, account])
      await call('POST', `/v1/connections/${a}/sync`, w.users.adminA);
    const results = await drainSync();
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed', 'succeeded']);
    const list = (await call('GET', `/v1/organizations/${w.orgA}/connections`, w.users.adminA)).body
      .items as Array<{
      id: string;
      status: string;
      lastRun: { status: string; failureKind: string };
    }>;
    const st = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(st[bad]!.status).toBe('temporary_error');
    expect(st[bad]!.lastRun.failureKind).toBe('transient');
    expect(st[expired]!.status).toBe('credentials_expired');
    expect(st[account]!.status).toBe('connected');
    // Recuperación: al corregir el modo, la siguiente sincronización funciona.
    await call('PATCH', `/v1/connections/${bad}`, w.users.adminA, { syncMode: 'ok' });
    await call('POST', `/v1/connections/${bad}/sync`, w.users.adminA);
    expect((await drainSync())[0]).toMatchObject({ status: 'succeeded', counters: { created: 3 } });
  });

  it('el barrido programa sincronizaciones vencidas', async () => {
    await seed`update public.connected_accounts set next_run_at = now() - interval '1 minute' where id = ${account}`;
    expect(await scheduleDueSyncs(deps)).toBeGreaterThanOrEqual(1);
    const res = await drainSync();
    expect(res.some((r) => r.status === 'succeeded')).toBe(true);
  });
});

describe('Fase 2 · bandeja', () => {
  it('filtra, busca, ordena y pagina', async () => {
    const base = `/v1/organizations/${w.orgA}/interactions`;
    const all = await call('GET', `${base}?clientId=${w.clientA1}&pageSize=5`, w.users.adminA);
    expect(all.body.total).toBe(12);
    expect(all.body.items).toHaveLength(5);
    const crit = await call('GET', `${base}?clientId=${w.clientA1}&priority=4`, w.users.adminA);
    expect(crit.body.items.every((i: { priority: number }) => i.priority === 4)).toBe(true);
    const gluten = await call('GET', `${base}?q=gluten`, w.users.adminA);
    expect(gluten.body.total).toBe(1);
    const low = await call(
      'GET',
      `${base}?clientId=${w.clientA1}&ratingMax=2&sort=rating&dir=asc`,
      w.users.adminA,
    );
    expect(low.body.items.every((i: { rating: string }) => Number(i.rating) <= 2)).toBe(true);
    expect(Number(low.body.items[0].rating)).toBe(1);
    const states = await call('GET', `${base}?state=new,pending_response`, w.users.adminA);
    expect(states.status).toBe(200);
    const bad = await call('GET', `${base}?state=hackeado`, w.users.adminA);
    expect(bad.status).toBe(400);
  });

  it('aísla organizaciones y clientes no asignados', async () => {
    const id = await byText('gluten');
    expect((await call('GET', `/v1/interactions/${id}`, w.users.adminB)).status).toBe(404);
    expect(
      (await call('GET', `/v1/organizations/${w.orgA}/interactions`, w.users.adminB)).status,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/interactions/${id}/drafts`, w.users.adminB, { content: 'x' }))
        .status,
    ).toBe(404);
    // managerA no está asignado a clientA2: no ve sus interacciones.
    const r = await call(
      'GET',
      `/v1/organizations/${w.orgA}/interactions?clientId=${w.clientA2}`,
      w.users.managerA,
    );
    expect(r.body.total).toBe(0);
  });

  it('asigna y cambia prioridad dejando historial', async () => {
    const id = await byText('gluten');
    expect(
      (
        await call('PATCH', `/v1/interactions/${id}`, w.users.managerA, {
          assigneeId: w.users.managerA,
          priority: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('PATCH', `/v1/interactions/${id}`, w.users.managerA, {
          assigneeId: w.users.adminB,
        })
      ).status,
    ).toBe(400);
    const d = await detail(id);
    expect(d.interaction.assigneeId).toBe(w.users.managerA);
    expect(d.events.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(['assigned', 'priority_changed']),
    );
    const mine = await call(
      'GET',
      `/v1/organizations/${w.orgA}/interactions?assignee=me`,
      w.users.managerA,
    );
    expect(mine.body.items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('las acciones por lotes son por elemento y no permiten aprobar', async () => {
    const ids = (
      await seed<{ id: string }[]>`
      select id from public.external_interactions where connected_account_id = ${account} and content like '%postres%'
       union all select id from public.external_interactions where client_id = ${w.clientB1} limit 1`
    ).map((r) => r.id);
    const [foreign] = await seed<{ id: string }[]>`
      insert into public.external_interactions (organization_id, client_id, provider, kind, external_id, content, content_hash, original_created_at)
      values (${w.orgB}, ${w.clientB1}, 'simulator', 'review', 'x-1', 'ajena', 'h', now()) returning id`;
    const r = await call('POST', `/v1/organizations/${w.orgA}/interactions/batch`, w.users.adminA, {
      ids: [...ids, foreign!.id],
      action: 'set_priority',
      priority: 1,
    });
    expect(r.body).toMatchObject({ succeeded: 1, failed: 1 });
    const approve = await call(
      'POST',
      `/v1/organizations/${w.orgA}/interactions/batch`,
      w.users.adminA,
      { ids, action: 'approve' },
    );
    expect(approve.status).toBe(400);
  });
});

describe('Fase 2 · borradores, aprobación y publicación', () => {
  it('flujo completo: publica una sola vez y verifica', async () => {
    const id = await byText('Comida excelente');
    const denied = await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
      decision: 'approve',
      contentHash: 'a'.repeat(64),
    });
    expect(denied.status).toBe(409); // no está pendiente de aprobación
    const text = '¡Gracias, Lucía! Nos alegra mucho que disfrutarais. Os esperamos pronto.';
    await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, { content: text });
    await call('POST', `/v1/interactions/${id}/request-approval`, w.users.managerA);
    // managerA no tiene permiso de aprobación.
    expect(
      (
        await call('POST', `/v1/interactions/${id}/decision`, w.users.managerA, {
          decision: 'approve',
          contentHash: await responseHash(text),
        })
      ).status,
    ).toBe(403);
    // Hash distinto del texto actual → conflicto.
    expect(
      (
        await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
          decision: 'approve',
          contentHash: await responseHash(text + '!'),
        })
      ).status,
    ).toBe(409);
    const approvals = await call('GET', `/v1/organizations/${w.orgA}/approvals`, w.users.approverA);
    expect(approvals.body.items.map((i: { id: string }) => i.id)).toContain(id);
    expect(
      (await call('GET', `/v1/organizations/${w.orgA}/approvals`, w.users.managerA)).body.items,
    ).toHaveLength(0);

    const ok = await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
      decision: 'approve',
      contentHash: await responseHash(text),
    });
    expect(ok.status).toBe(200);
    expect((await detail(id)).interaction.state).toBe('approved');
    const [pub] = await drainPublish();
    expect(pub).toMatchObject({ status: 'published' });
    const d = await detail(id);
    expect(d.interaction.state).toBe('published');
    expect(d.receipts).toHaveLength(1);
    expect(d.receipts[0].publishedContentHash).toBe(await responseHash(text));
    expect(d.attempts.filter((a: { operation: string }) => a.operation === 'publish')).toHaveLength(
      1,
    );

    // Un aviso duplicado no vuelve a publicar.
    expect(await runPublish(deps, ok.body.jobId)).toMatchObject({ status: 'skip' });
    const [{ n } = { n: -1 }] = await seed<{ n: number }[]>`
      select count(*)::int as n from public.publication_attempts where job_id = ${ok.body.jobId} and operation = 'publish'`;
    expect(n).toBe(1);
    // Ni editar ni volver a aprobar tras publicar.
    expect(
      (await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, { content: 'otra' }))
        .status,
    ).toBe(409);
    const [remote] =
      await seed`select reply_content from private.simulator_remote where interaction_external_id = (select external_id from public.external_interactions where id = ${id})`;
    expect(remote!.replyContent).toBe(text);
  });

  it('editar después de aprobar invalida la aprobación y cancela la publicación', async () => {
    const id = await byText('postres');
    const jobId = await approveFlow(id, 'Gracias, Marcos. Tomamos nota sobre los postres.');
    const edit = await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, {
      content: 'Gracias, Marcos. Revisaremos los tiempos de cocina.',
    });
    expect(edit.status).toBe(201);
    const d = await detail(id);
    expect(d.interaction.state).toBe('draft_generated');
    expect(d.jobs[0].status).toBe('cancelled');
    queue.take(QUEUES.publish);
    expect(await runPublish(deps, jobId)).toMatchObject({ status: 'skip' });
    // Ni siquiera insertando directamente en la BD se puede publicar con la aprobación antigua.
    const [old] = await seed<
      { approvalId: string; draftId: string; content: string; contentHash: string }[]
    >`
      select approval_id, draft_id, content, content_hash from public.publication_jobs where id = ${jobId}`;
    await expectSqlError(
      seed`
      insert into public.publication_jobs (organization_id, client_id, interaction_id, draft_id, approval_id, connected_account_id, content, content_hash, idempotency_key)
      values (${w.orgA}, ${w.clientA1}, ${id}, ${old!.draftId}, ${old!.approvalId}, ${account}, ${old!.content}, ${old!.contentHash}, 'manual-1')`,
      '42501',
    );
  });

  it('la BD rechaza publicar sin aprobación o con un texto distinto', async () => {
    const id = await byText('Correcto sin más');
    await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, {
      content: 'Gracias, Raúl.',
    });
    const [draft] = await seed<
      { id: string; contentHash: string }[]
    >`select id, content_hash from public.response_drafts where interaction_id = ${id}`;
    await expectSqlError(
      seed`
      insert into public.publication_jobs (organization_id, client_id, interaction_id, draft_id, approval_id, connected_account_id, content, content_hash, idempotency_key)
      values (${w.orgA}, ${w.clientA1}, ${id}, ${draft!.id}, gen_random_uuid(), ${account}, 'Gracias, Raúl.', ${draft!.contentHash}, 'manual-2')`,
      ['42501', '23503'],
    );
    // Saltarse estados directamente en la BD también falla.
    await expectSqlError(
      seed`update public.external_interactions set state = 'published' where id = ${id}`,
      '23514',
    );
    // Los usuarios no pueden escribir en tablas de flujo aunque tengan permisos en la app.
    await expectSqlError(
      asUser(
        seed,
        w.users.adminA,
        (tx) => tx`
      insert into public.response_approvals (organization_id, client_id, interaction_id, draft_id, content_hash, decision, decided_by)
      values (${w.orgA}, ${w.clientA1}, ${id}, ${draft!.id}, ${draft!.contentHash}, 'approved', ${w.users.adminA})`,
      ),
      '42501',
    );
    await expectSqlError(
      asUser(
        seed,
        w.users.adminA,
        (tx) => tx`update public.external_interactions set state = 'approved' where id = ${id}`,
      ),
      '42501',
    );
    await expectSqlError(
      seed`update public.response_drafts set content = 'otro' where id = ${draft!.id}`,
      '42501',
    );
  });

  it('rechazar o devolver exige motivo y vuelve a borrador', async () => {
    const id = await byText('Correcto sin más');
    await call('POST', `/v1/interactions/${id}/request-approval`, w.users.managerA);
    const hash = (await detail(id)).drafts[0].contentHash;
    expect(
      (
        await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
          decision: 'reject',
          contentHash: hash,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
          decision: 'return',
          contentHash: hash,
          note: 'Más cercano',
        })
      ).status,
    ).toBe(200);
    expect((await detail(id)).interaction.state).toBe('draft_generated');
  });

  it('exige confirmar la revisión especializada en casos delicados', async () => {
    const id = await byText('abogado');
    const text =
      'Lamentamos mucho su experiencia. Le hemos escrito por privado para atender su reclamación.';
    await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, { content: text });
    await call('POST', `/v1/interactions/${id}/request-approval`, w.users.managerA);
    const r = await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
      decision: 'approve',
      contentHash: await responseHash(text),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe('specialist_required');
    const ok = await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
      decision: 'approve',
      contentHash: await responseHash(text),
      specialistReviewed: true,
    });
    expect(ok.status).toBe(200);
    expect((await drainPublish())[0]).toMatchObject({ status: 'published' });
  });

  it('respuesta ambigua: consulta el estado remoto y no duplica', async () => {
    await call('PATCH', `/v1/connections/${account}`, w.users.adminA, { publishMode: 'ambiguous' });
    const id = await byText('terraza');
    await approveFlow(id, 'Gracias, Elena. Tomamos nota sobre los precios.');
    expect((await drainPublish())[0]).toMatchObject({ status: 'published', viaStatusCheck: true });
    const d = await detail(id);
    expect(d.interaction.state).toBe('published');
    const ops = d.attempts
      .map((a: { operation: string; outcome: string }) => `${a.operation}:${a.outcome}`)
      .sort();
    expect(ops).toEqual(['publish:ambiguous', 'status_check:published']);
    const [{ n } = { n: -1 }] = await seed<{ n: number }[]>`
      select count(*)::int as n from private.simulator_remote r join public.external_interactions i
          on i.external_id = r.interaction_external_id and i.connected_account_id = r.connected_account_id where i.id = ${id}`;
    expect(n).toBe(1);
  });

  it('error definitivo: queda fallida; el reintento manual consulta antes de publicar', async () => {
    await call('PATCH', `/v1/connections/${account}`, w.users.adminA, { publishMode: 'error' });
    const id = await byText('arroz');
    await approveFlow(id, 'Gracias, Diego. Se lo diremos al equipo de cocina.');
    expect((await drainPublish())[0]).toMatchObject({ status: 'failed', willRetry: false });
    expect((await detail(id)).interaction.state).toBe('publish_failed');
    expect(
      (
        await call('POST', `/v1/interactions/${id}/actions`, w.users.managerA, {
          action: 'retry_publish',
        })
      ).status,
    ).toBe(403);
    await call('PATCH', `/v1/connections/${account}`, w.users.adminA, { publishMode: 'ok' });
    expect(
      (
        await call('POST', `/v1/interactions/${id}/actions`, w.users.approverA, {
          action: 'retry_publish',
        })
      ).status,
    ).toBe(200);
    expect((await drainPublish())[0]).toMatchObject({ status: 'published' });
    const ops = (await detail(id)).attempts
      .map((a: { operation: string; outcome: string }) => `${a.operation}:${a.outcome}`)
      .sort();
    expect(ops).toEqual(['publish:failed', 'publish:published', 'status_check:not_found']);
  });

  it('límite de peticiones: reintenta con espera', async () => {
    await call('PATCH', `/v1/connections/${account}`, w.users.adminA, {
      publishMode: 'rate_limited',
    });
    const id = await byText('cumpleaños');
    await approveFlow(id, 'Gracias, Tomás. ¡Felicidades!');
    expect((await drainPublish())[0]).toMatchObject({ status: 'failed', willRetry: true });
    const [again] = queue.sent.filter((s) => s.name === QUEUES.publish);
    expect(again!.startAfterSeconds).toBe(30);
    await call('PATCH', `/v1/connections/${account}`, w.users.adminA, { publishMode: 'ok' });
    expect((await drainPublish())[0]).toMatchObject({ status: 'published' });
  });

  it('el interruptor global bloquea la publicación sin perderla', async () => {
    await seed`update public.platform_settings set value = '{"enabled": true, "reason": "prueba"}' where key = 'publishing_kill_switch'`;
    const id = await byText('nadie se disculpó');
    const jobId = await approveFlow(id, 'Sentimos mucho la espera, Ana.');
    expect((await drainPublish())[0]).toMatchObject({ status: 'blocked' });
    expect((await detail(id)).interaction.state).toBe('approved');
    await seed`update public.platform_settings set value = '{"enabled": false, "reason": null}' where key = 'publishing_kill_switch'`;
    // El barrido recupera el trabajo en cola.
    expect(await sweepPublications(deps, { staleQueuedSeconds: 0 })).toBeGreaterThanOrEqual(1);
    expect(queue.sent.map((s) => s.id)).toContain(jobId);
    expect((await drainPublish())[0]).toMatchObject({ status: 'published' });
  });

  it('la pausa de la organización también bloquea', async () => {
    await seed`update public.organizations set publishing_paused = true where id = ${w.orgA}`;
    const id = await byText('sin gluten');
    await approveFlow(id, 'Sí, Carmen: tenemos carta sin gluten. Pídela al llegar.');
    expect((await drainPublish())[0]).toMatchObject({ status: 'blocked' });
    await seed`update public.organizations set publishing_paused = false where id = ${w.orgA}`;
  });

  it('si el autor edita su reseña durante la revisión, se vuelve a borrador', async () => {
    const id = await byText('malestar');
    const text = 'Sentimos mucho lo ocurrido. Nos pondremos en contacto con usted.';
    await call('POST', `/v1/interactions/${id}/drafts`, w.users.managerA, { content: text });
    await call('POST', `/v1/interactions/${id}/request-approval`, w.users.managerA);
    const [{ externalId } = { externalId: '' }] = await seed<
      { externalId: string }[]
    >`select external_id from public.external_interactions where id = ${id}`;
    await call('POST', `/v1/connections/${account}/simulate-edit`, w.users.adminA, {
      externalId,
      content: 'Actualizo: tuvimos que ir a urgencias.',
      rating: 1,
    });
    await call('POST', `/v1/connections/${account}/sync`, w.users.adminA);
    expect((await drainSync())[0]).toMatchObject({ status: 'succeeded', counters: { updated: 1 } });
    const d = await detail(id);
    expect(d.interaction.state).toBe('draft_generated');
    expect(d.interaction.content).toContain('urgencias');
    expect(d.versions).toHaveLength(2);
    expect(d.events.map((e: { eventType: string }) => e.eventType)).toContain(
      'source_content_changed',
    );
  });

  it('descartar y reabrir', async () => {
    const id = await byText('Volveremos'); // ya publicada
    expect(
      (
        await call('POST', `/v1/interactions/${id}/actions`, w.users.managerA, {
          action: 'discard',
        })
      ).status,
    ).toBe(409);
    const other = await byText('barra');
    expect(
      (
        await call('POST', `/v1/interactions/${other}/actions`, w.users.managerA, {
          action: 'discard',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('POST', `/v1/interactions/${other}/actions`, w.users.managerA, {
          action: 'reopen',
        })
      ).body.state,
    ).toBe('pending_response');
  });

  it('el resumen refleja datos reales y la auditoría registra decisiones', async () => {
    const o = (await call('GET', `/v1/organizations/${w.orgA}/overview`, w.users.adminA)).body;
    expect(o.inbox.published7d).toBeGreaterThanOrEqual(4);
    expect(o.inbox.simulated).toBeGreaterThan(0);
    expect(o.sources.simulated).toBe(3);
    const [{ n } = { n: -1 }] = await seed<{ n: number }[]>`
      select count(*)::int as n from public.audit_logs where organization_id = ${w.orgA} and action = 'response.approved'`;
    expect(n).toBeGreaterThanOrEqual(5);
  });
});
