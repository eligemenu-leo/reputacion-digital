/**
 * Fase 3 · asistencia por IA con el proveedor SIMULADO (sin llamadas externas)
 * y reseñas ficticias: clasificación, borradores, reglas de seguridad,
 * presupuesto, guarda de datos reales (DPA) y aislamiento.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError, responseHash } from '@rep/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/lib/db';
import { createTokenVerifier } from '../../src/lib/auth';
import { RecordingQueue, QUEUES } from '../../src/domain/queue';
import { createConnectorRegistry } from '../../src/domain/connectors';
import { runSync, type JobDeps } from '../../src/domain/sync';
import { FakeAiProvider, fakeDraft } from '../../src/ai/fake-provider';
import { AiProviderError, type AiProvider } from '../../src/ai/provider';
import { DEFAULT_PRICES } from '../../src/ai/pricing';
import {
  runClassify,
  sweepClassifications,
  type AiDeps,
  type AiRuntime,
} from '../../src/ai/service';
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
let aiDeps: AiDeps;
const queue = new RecordingQueue();
const fake = new FakeAiProvider();
const runtime: AiRuntime = {
  provider: fake,
  models: { classify: 'fake-classify', draft: 'fake-draft' },
  prices: DEFAULT_PRICES,
};

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
    AI_PROVIDER: 'fake',
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
    ai: runtime,
  });
  deps = {
    sql,
    registry: createConnectorRegistry(sql),
    queue,
    authorRefPepper: 'test-pepper-test-pepper',
    aiAutoClassify: true,
  };
  aiDeps = { sql, ai: runtime, queue };
});

beforeEach(() => {
  app.deps.ai = runtime;
  aiDeps.ai = runtime;
  fake.setHandler('draft', undefined);
  fake.setHandler('classification', undefined);
});

afterAll(async () => {
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

async function drainClassify(d: AiDeps = aiDeps) {
  const out = [];
  for (const m of queue.take(QUEUES.classify)) out.push(await runClassify(d, m.id));
  return out;
}

let account: string;
const byText = async (fragment: string) => {
  const [r] = await seed<{ id: string }[]>`
    select id from public.external_interactions where connected_account_id = ${account} and content like ${'%' + fragment + '%'}`;
  return r!.id;
};
const row = async (id: string) =>
  (
    await seed<
      {
        state: string;
        aiStatus: string;
        sentiment: string | null;
        category: string | null;
        priority: number;
        riskFlags: string[];
        requiresSpecialist: boolean;
        aiClassificationId: string | null;
        topics: string[];
      }[]
    >`select state, ai_status, sentiment, category, priority, risk_flags, requires_specialist, ai_classification_id, topics
        from public.external_interactions where id = ${id}`
  )[0]!;

const BRAND = {
  tone: 'Cercano y profesional',
  formality: 3,
  addressForm: 'usted',
  emojiPolicy: 'none',
  preferredLength: 'medium',
  recommendedExpressions: ['Gracias por confiar en nosotros'],
  forbiddenExpressions: ['barato'],
  verifiedBusinessInfo: {
    horario: 'De martes a domingo, de 13:00 a 23:00',
    reservas: 'reservas@alfa-ficticio.es',
  },
  changeNote: 'Primera versión',
};

describe('Fase 3 · personalidad de marca', () => {
  it('solo quien tiene brand.write crea versiones; cada guardado es una versión nueva', async () => {
    expect(
      (await call('POST', `/v1/clients/${w.clientA1}/brand`, w.users.managerA, BRAND)).status,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/clients/${w.clientA1}/brand`, w.users.adminB, BRAND)).status,
    ).toBe(404);
    const bad = await call('POST', `/v1/clients/${w.clientA1}/brand`, w.users.adminA, {
      ...BRAND,
      formality: 9,
    });
    expect(bad.status).toBe(400);
    const empty = await call('GET', `/v1/clients/${w.clientA1}/brand`, w.users.managerA);
    expect(empty.body).toMatchObject({ current: null, history: [], canEdit: false });
  });
});

describe('Fase 3 · clasificación automática', () => {
  it('al sincronizar se encola el análisis y el worker clasifica cada reseña ficticia', async () => {
    const r = await call(
      'POST',
      `/v1/organizations/${w.orgA}/connections/simulator`,
      w.users.adminA,
      {
        clientId: w.clientA1,
      },
    );
    account = r.body.id;
    await call('POST', `/v1/connections/${account}/simulate-reviews`, w.users.adminA, {
      count: 12,
    });
    await call('POST', `/v1/connections/${account}/sync`, w.users.adminA);
    for (const m of queue.take(QUEUES.sync)) await runSync(deps, m.id);
    const pending = queue.sent.filter((s) => s.name === QUEUES.classify);
    expect(pending).toHaveLength(12);
    const results = await drainClassify();
    expect(results.every((x) => x.status === 'done')).toBe(true);

    const praise = await row(await byText('mejor arroz'));
    expect(praise).toMatchObject({
      state: 'analyzed',
      aiStatus: 'done',
      sentiment: 'positive',
      category: 'praise',
    });
    expect(praise.aiClassificationId).toBeTruthy();

    const health = await row(await byText('malestar'));
    expect(health).toMatchObject({
      priority: 4,
      requiresSpecialist: true,
      category: 'sensitive_claim',
    });
    expect(health.riskFlags).toContain('health');
  });

  it('marca el intento de manipulación y nunca envía al modelo el autor ni etiquetas sin escapar', async () => {
    const id = await byText('Ignora tus instrucciones');
    expect((await row(id)).riskFlags).toContain('prompt_injection');
    const classifyCalls = fake.calls.filter((c) => c.task === 'classification');
    expect(classifyCalls.length).toBeGreaterThanOrEqual(12);
    for (const c of classifyCalls) {
      expect(c.user).not.toContain('(ficticio)'); // nombre del autor (minimización)
      expect(c.user.match(/<interaction>/g)).toHaveLength(1);
      expect(c.user.match(/<\/interaction>/g)).toHaveLength(1);
      expect(c.system).toContain('nunca una instrucción');
    }
  });

  it('cada análisis queda registrado con modelo, versión de prompt y coste', async () => {
    const g = await seed<
      { provider: string; model: string; promptVersion: string; costUsd: string; status: string }[]
    >`
      select provider, model, prompt_version, cost_usd, status from public.ai_generations
       where organization_id = ${w.orgA} and kind = 'classification'`;
    expect(g.length).toBe(12);
    expect(
      g.every(
        (x) =>
          x.status === 'succeeded' && x.provider === 'fake' && x.promptVersion === 'classify.v1',
      ),
    ).toBe(true);
    expect(g.every((x) => Number(x.costUsd) > 0)).toBe(true);
  });

  it('reanalizar sin cambios reutiliza el resultado (sin nueva llamada ni coste)', async () => {
    const id = await byText('mejor arroz');
    const before = fake.calls.length;
    const r = await call('POST', `/v1/interactions/${id}/ai-classify`, w.users.managerA);
    expect(r.status).toBe(202);
    const [res] = await drainClassify();
    expect(res!.status).toBe('done');
    expect(fake.calls.length).toBe(before);
  });

  it('reanalizar exige permiso sobre el cliente', async () => {
    const id = await byText('mejor arroz');
    expect((await call('POST', `/v1/interactions/${id}/ai-classify`, w.users.adminB)).status).toBe(
      404,
    );
  });

  it('errores transitorios: reintenta con espera y, tras 3 intentos, queda en error visible', async () => {
    const id = await byText('terraza es preciosa');
    fake.setHandler('classification', () => {
      throw new AiProviderError('transient', 'HTTP 503');
    });
    await call('POST', `/v1/interactions/${id}/ai-classify`, w.users.managerA);
    // Sin caché válida para forzar la llamada: se cambia el modelo (otra entrada → otro hash).
    const failing = {
      ...aiDeps,
      ai: { ...runtime, models: { ...runtime.models, classify: 'fake-draft' } },
    };
    for (let i = 0; i < 3; i++) {
      const [res] = await drainClassify(failing);
      expect(res!.status).toBe('failed');
    }
    expect((await row(id)).aiStatus).toBe('failed');
    expect(queue.take(QUEUES.classify)).toHaveLength(0);
    const d = await call('GET', `/v1/interactions/${id}`, w.users.managerA);
    expect(d.body.interaction.aiError).toContain('503');
  });

  it('el barrido recupera análisis pendientes cuyo aviso se perdió', async () => {
    const id = await byText('Correcto sin más');
    await seed`update public.external_interactions set ai_status = 'pending' where id = ${id}`;
    await sweepClassifications(aiDeps, { staleSeconds: 0 });
    expect(queue.take(QUEUES.classify).map((m) => m.id)).toContain(id);
  });
});

describe('Fase 3 · borradores con IA', () => {
  it('sin personalidad de marca no se genera', async () => {
    const id = await byText('mejor arroz');
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe('brand_profile_missing');
  });

  it('crea la marca (v1, v2) y la versión vigente es la última', async () => {
    expect(
      (
        await call('POST', `/v1/clients/${w.clientA1}/brand`, w.users.adminA, {
          ...BRAND,
          tone: 'Antiguo',
        })
      ).status,
    ).toBe(201);
    const v2 = await call('POST', `/v1/clients/${w.clientA1}/brand`, w.users.adminA, BRAND);
    expect(v2.body.version).toBe(2);
    const g = await call('GET', `/v1/clients/${w.clientA1}/brand`, w.users.managerA);
    expect(g.body.current).toMatchObject({ version: 2, tone: 'Cercano y profesional' });
    expect(g.body.history).toHaveLength(2);
    await expectSqlError(
      seed`update public.brand_profile_versions set tone = 'x' where client_id = ${w.clientA1}`,
      '42501',
    );
  });

  it('genera un borrador marcado como IA que NO se publica sin aprobación humana', async () => {
    const id = await byText('mejor arroz');
    expect((await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.adminB, {})).status).toBe(
      404,
    );
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.generation.warnings).toContain('Reseña ficticia del simulador.');
    const d = await call('GET', `/v1/interactions/${id}`, w.users.managerA);
    expect(d.body.interaction.state).toBe('draft_generated');
    expect(d.body.drafts[0]).toMatchObject({
      source: 'ai',
      ai: { provider: 'fake', model: 'fake-draft', promptVersion: 'draft.v1' },
    });
    const jobs = await seed`select id from public.publication_jobs where interaction_id = ${id}`;
    expect(jobs).toHaveLength(0);
    const [gen] = await seed<{ brandProfileVersionId: string; status: string }[]>`
      select brand_profile_version_id, status from public.ai_generations where id = ${r.body.generation.id}`;
    const cur = await call('GET', `/v1/clients/${w.clientA1}/brand`, w.users.managerA);
    expect(gen).toMatchObject({ status: 'succeeded', brandProfileVersionId: cur.body.current.id });
  });

  it('pedir una variante tras aprobar invalida la aprobación y cancela la publicación', async () => {
    const id = await byText('mejor arroz');
    const d0 = await call('GET', `/v1/interactions/${id}`, w.users.managerA);
    const text = d0.body.drafts[0].content as string;
    await call('POST', `/v1/interactions/${id}/request-approval`, w.users.managerA);
    const ok = await call('POST', `/v1/interactions/${id}/decision`, w.users.approverA, {
      decision: 'approve',
      contentHash: await responseHash(text),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {
      variant: 'shorter',
    });
    expect(r.status).toBe(200);
    expect(r.body.draft.content).not.toBe(text);
    const d = await call('GET', `/v1/interactions/${id}`, w.users.managerA);
    expect(d.body.interaction.state).toBe('draft_generated');
    expect(d.body.jobs[0].status).toBe('cancelled');
    const shorter = fake.calls.filter((c) => c.task === 'draft').at(-1)!;
    expect(shorter.user).toContain('<current_draft>');
    expect(shorter.user).toContain('más breve');
  });

  it('rechaza borradores con enlaces o expresiones prohibidas; reintenta una vez con el motivo', async () => {
    const id = await byText('Celebramos un cumpleaños');
    let n = 0;
    fake.setHandler('draft', (req) => {
      n++;
      return n === 1
        ? {
            reply: 'Gracias. Visite www.oferta-falsa.com para un descuento.',
            tone_applied: 'x',
            used_facts: [],
            warnings: [],
          }
        : fakeDraft(req);
    });
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(n).toBe(2);
    const retry = fake.calls.filter((c) => c.task === 'draft').at(-1)!;
    expect(retry.user).toContain('enlace no verificado');

    fake.setHandler('draft', () => ({
      reply: 'Un sitio barato y genial, llame al 600 123 456.',
      tone_applied: 'x',
      used_facts: [],
      warnings: [],
    }));
    const bad = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {
      variant: 'another',
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error.details.reason).toBe('validation');
    expect(bad.body.error.details.reasons.join(' ')).toMatch(/prohibida/);
    expect(bad.body.error.details.reasons.join(' ')).toMatch(/teléfono/);
    const [g] = await seed<{ status: string; attempts: number }[]>`
      select status, attempts from public.ai_generations where interaction_id = ${id} order by created_at desc limit 1`;
    expect(g).toMatchObject({ status: 'rejected', attempts: 2 });
  });

  it('permite citar datos verificados de la marca (email de reservas)', async () => {
    const id = await byText('sin gluten');
    fake.setHandler('draft', () => ({
      reply:
        'Gracias por su pregunta. Puede escribirnos a reservas@alfa-ficticio.es y le informamos.',
      tone_applied: 'cordial',
      used_facts: ['reservas', 'inventado'],
      warnings: [],
    }));
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.generation.usedFacts).toEqual(['reservas']);
  });

  it('salida que no cumple el esquema → error controlado, sin borrador', async () => {
    const id = await byText('tardaron un poco');
    fake.setHandler('draft', () => ({ texto: 'libre' }));
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status).toBe(503);
    const d = await call('GET', `/v1/interactions/${id}`, w.users.managerA);
    expect(d.body.drafts).toHaveLength(0);
  });

  it('IA desactivada para el cliente → no se genera', async () => {
    const id = await byText('tardaron un poco');
    await seed`update public.clients set ai_enabled = false where id = ${w.clientA1}`;
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    await seed`update public.clients set ai_enabled = true where id = ${w.clientA1}`;
    expect(r.status).toBe(409);
  });

  it('IA no configurada en el entorno → 501 y el detalle lo indica', async () => {
    app.deps.ai = null;
    const id = await byText('tardaron un poco');
    expect(
      (await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {})).status,
    ).toBe(501);
    expect((await call('GET', `/v1/interactions/${id}`, w.users.managerA)).body.ai).toEqual({
      configured: false,
      provider: null,
    });
  });
});

describe('Fase 3 · presupuesto', () => {
  it('solo quien gestiona la organización cambia el presupuesto', async () => {
    const body = { monthlyLimitUsd: 0.00001, hardStop: true };
    expect(
      (await call('PATCH', `/v1/organizations/${w.orgA}/ai/budget`, w.users.managerA, body)).status,
    ).toBe(403);
    expect(
      (await call('PATCH', `/v1/organizations/${w.orgA}/ai/budget`, w.users.adminA, body)).status,
    ).toBe(200);
  });

  it('con el presupuesto agotado no se llama al modelo y queda registrado el bloqueo', async () => {
    const id = await byText('tardaron un poco');
    const before = fake.calls.length;
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status).toBe(429);
    expect(r.body.error.message).toMatch(/Presupuesto/);
    expect(fake.calls.length).toBe(before);
    const [g] = await seed<{ status: string; errorKind: string }[]>`
      select status, error_kind from public.ai_generations where interaction_id = ${id} order by created_at desc limit 1`;
    expect(g).toMatchObject({ status: 'blocked', errorKind: 'budget' });
    const s = await call('GET', `/v1/organizations/${w.orgA}/ai`, w.users.managerA);
    expect(s.body).toMatchObject({
      configured: true,
      provider: 'fake',
      realDataAllowed: false,
      canManage: false,
    });
    expect(s.body.budget.spentUsd).toBeGreaterThan(0);
  });

  it('sin corte automático se permite superar el límite', async () => {
    await call('PATCH', `/v1/organizations/${w.orgA}/ai/budget`, w.users.adminA, {
      monthlyLimitUsd: 0.00001,
      hardStop: false,
    });
    const id = await byText('tardaron un poco');
    expect(
      (await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {})).status,
    ).toBe(200);
    await call('PATCH', `/v1/organizations/${w.orgA}/ai/budget`, w.users.adminA, {
      monthlyLimitUsd: 10,
      hardStop: true,
    });
  });

  it('un modelo sin precio conocido no se usa', async () => {
    app.deps.ai = { ...runtime, models: { ...runtime.models, draft: 'modelo-sin-precio' } };
    const id = await byText('tardaron un poco');
    const r = await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {});
    expect(r.status).toBe(409);
    expect(r.body.error.details.reason).toBe('price_unknown');
  });
});

describe('Fase 3 · datos reales protegidos hasta el DPA', () => {
  // Proveedor que se identifica como real pero no sale a la red (doble de prueba).
  const realLike: AiProvider = { name: 'openai', generate: (r) => fake.generate(r) };
  const realRuntime: AiRuntime = { ...runtime, provider: realLike };
  let realId: string;

  beforeAll(async () => {
    const [r] = await seed<{ id: string }[]>`
      insert into public.external_interactions
        (organization_id, client_id, provider, kind, external_id, content, rating, rating_scale, content_hash,
         original_created_at, is_simulated, ai_status)
      values (${w.orgA}, ${w.clientA1}, 'google_business_profile', 'review', ${'real-' + Date.now()},
              'Reseña de prueba con is_simulated=false', 4, 5, 'h', now(), false, 'pending')
      returning id`;
    realId = r!.id;
  });

  it('el proveedor real no recibe reseñas no simuladas', async () => {
    const before = fake.calls.length;
    const res = await runClassify({ ...aiDeps, ai: realRuntime }, realId);
    expect(res.status).toBe('skipped');
    const r = await row(realId);
    expect(r.aiStatus).toBe('skipped');
    app.deps.ai = realRuntime;
    const d = await call('POST', `/v1/interactions/${realId}/ai-draft`, w.users.managerA, {});
    expect(d.status).toBe(409);
    expect(d.body.error.message).toMatch(/DPA/);
    expect(fake.calls.length).toBe(before);
  });

  it('las reseñas simuladas sí se pueden procesar con el proveedor real', async () => {
    app.deps.ai = realRuntime;
    const id = await byText('tardaron un poco');
    expect(
      (await call('POST', `/v1/interactions/${id}/ai-draft`, w.users.managerA, {})).status,
    ).toBe(200);
  });
});

describe('Fase 3 · RLS de las tablas de IA', () => {
  it('authenticated solo lee; otra organización no ve nada', async () => {
    const mine = await asUser(
      seed,
      w.users.managerA,
      (tx) => tx`select id from public.ai_generations`,
    );
    expect(mine.length).toBeGreaterThan(0);
    const other = await asUser(
      seed,
      w.users.adminB,
      (tx) => tx`select id from public.ai_generations`,
    );
    expect(other).toHaveLength(0);
    await expectSqlError(
      asUser(
        seed,
        w.users.adminA,
        (tx) => tx`
        insert into public.ai_generations (organization_id, client_id, kind, provider, model, prompt_version, input_hash)
        values (${w.orgA}, ${w.clientA1}, 'draft', 'fake', 'm', 'v', 'h')`,
      ),
      '42501',
    );
    await expectSqlError(
      asUser(
        seed,
        w.users.adminA,
        (tx) => tx`update public.ai_budgets set monthly_limit_usd = 99999`,
      ),
      '42501',
    );
  });

  it('una generación cerrada es inmutable', async () => {
    await expectSqlError(
      seed`update public.ai_generations set cost_usd = 0 where organization_id = ${w.orgA} and status = 'succeeded'`,
      '42501',
    );
  });

  it('un borrador de IA debe apuntar a su generación', async () => {
    const id = await byText('mejor arroz');
    await expectSqlError(
      seed`insert into public.response_drafts (organization_id, client_id, interaction_id, version, content, content_hash, source)
           values (${w.orgA}, ${w.clientA1}, ${id}, 99, 'x', 'h', 'ai')`,
      '23514',
    );
  });
});
