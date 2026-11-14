/**
 * Fase 3 · informes: métricas observadas, resumen de IA validado contra las
 * cifras, hallazgos con respaldo mínimo, muestra insuficiente y guarda del DPA.
 * Datos ficticios insertados directamente; proveedor de IA simulado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '@rep/shared';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb } from '../../src/lib/db';
import { createTokenVerifier } from '../../src/lib/auth';
import { RecordingQueue } from '../../src/domain/queue';
import { FakeAiProvider } from '../../src/ai/fake-provider';
import type { AiProvider } from '../../src/ai/provider';
import { DEFAULT_PRICES } from '../../src/ai/pricing';
import type { AiRuntime } from '../../src/ai/service';
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
const fake = new FakeAiProvider();
const runtime: AiRuntime = {
  provider: fake,
  models: { classify: 'fake-classify', draft: 'fake-draft', summary: 'fake-summary' },
  prices: DEFAULT_PRICES,
};

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function insert(
  client: string,
  n: number,
  o: {
    topics: string[];
    rating: number;
    sentiment: string;
    daysAgo: number;
    simulated?: boolean;
    text?: string;
  },
) {
  for (let k = 0; k < n; k++) {
    await seed`
      insert into public.external_interactions
        (organization_id, client_id, provider, kind, external_id, author_display_name, content, rating, rating_scale,
         content_hash, original_created_at, is_simulated, sentiment, topics, ai_status)
      values (${w.orgA}, ${client}, 'simulator', 'review', ${`r-${Math.random()}`}, 'Autora Secreta (ficticia)',
              ${o.text ?? `Opinión ficticia sobre ${o.topics.join(' y ')} número ${k}`}, ${o.rating}, 5, 'h',
              ${day(o.daysAgo)}, ${o.simulated ?? true}, ${o.sentiment}, ${o.topics}, 'done')`;
  }
}

beforeAll(async () => {
  seed = db();
  w = await seedWorld(seed);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    SUPABASE_JWT_SECRET: JWT_SECRET,
    LOG_LEVEL: 'silent',
    JOBS_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
  app = await buildApp({
    config,
    sql: createDb(config),
    verifyToken: createTokenVerifier(config),
    authAdmin: {
      inviteUser: async () => {
        throw new AppError('NOT_SUPPORTED', 'no');
      },
    },
    queue: new RecordingQueue(),
    ai: runtime,
  });
  // Periodo actual: 12 interacciones; periodo anterior: 3.
  await insert(w.clientA1, 5, {
    topics: ['servicio'],
    rating: 2,
    sentiment: 'negative',
    daysAgo: 3,
  });
  await insert(w.clientA1, 4, { topics: ['comida'], rating: 5, sentiment: 'positive', daysAgo: 5 });
  await insert(w.clientA1, 3, { topics: ['precio'], rating: 3, sentiment: 'neutral', daysAgo: 8 });
  await insert(w.clientA1, 3, {
    topics: ['servicio'],
    rating: 4,
    sentiment: 'positive',
    daysAgo: 40,
  });
  await insert(w.clientA2, 2, {
    topics: ['limpieza'],
    rating: 4,
    sentiment: 'positive',
    daysAgo: 2,
  });
});

beforeEach(() => {
  app.deps.ai = runtime;
  fake.setHandler('summary', undefined);
});

afterAll(async () => {
  await app.close();
  await app.deps.sql.end();
  await seed.end();
});

const call = async (method: 'GET' | 'POST', url: string, userId?: string, body?: unknown) => {
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

describe('Fase 3 · métricas observadas', () => {
  it('calcula totales, medias, sentimiento, temas y comparación con el periodo anterior', async () => {
    const r = await call('GET', `/v1/clients/${w.clientA1}/insights`, w.users.managerA);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = r.body.metrics;
    expect(m).toMatchObject({
      total: 12,
      simulated: 12,
      rating_count: 12,
      negative_pct: 42,
      positive_pct: 33,
    });
    expect(m.rating_avg).toBe(3.3); // (5·2 + 4·5 + 3·3) / 12 = 3,25 → 3,3
    expect(m.rating_distribution).toEqual({ '1': 0, '2': 5, '3': 3, '4': 0, '5': 4 });
    expect(m.topics[0]).toMatchObject({
      topic: 'servicio',
      count: 5,
      negative_pct: 100,
      previous_count: 3,
    });
    expect(m.previous).toMatchObject({ total: 3, rating_avg: 4 });
    expect(m.period.days).toBe(30);
    expect(r.body.canCreateReport).toBe(true);
  });

  it('valida el periodo y aísla organizaciones', async () => {
    expect(
      (
        await call(
          'GET',
          `/v1/clients/${w.clientA1}/insights?from=2026-02-01&to=2026-01-01`,
          w.users.managerA,
        )
      ).status,
    ).toBe(400);
    expect((await call('GET', `/v1/clients/${w.clientA1}/insights`, w.users.adminB)).status).toBe(
      404,
    );
  });
});

describe('Fase 3 · informes con resumen de IA', () => {
  let reportId: string;

  it('genera el resumen solo con cifras de las métricas y hallazgos con ≥ 3 reseñas', async () => {
    const r = await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.managerA, {});
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('ready');
    reportId = r.body.id;
    const d = await call('GET', `/v1/reports/${reportId}`, w.users.managerA);
    expect(d.body.summary.headline).toContain('12');
    expect(d.body.summary.findings).toHaveLength(1);
    expect(d.body.summary.findings[0].topic).toBe('servicio');
    expect(d.body.summary.findings[0].supportingInteractionIds).toHaveLength(3);
    expect(d.body.warnings).toContain('Informe basado en reseñas ficticias del simulador.');
    const prompt = fake.calls.filter((c) => c.task === 'summary').at(-1)!;
    expect(prompt.user).toContain('<metrics>');
    expect(prompt.user).not.toContain('Autora Secreta');
    expect(prompt.user).toContain('<eligible_topics>');
    expect(prompt.user).toMatch(/- servicio \(\d+ menciones\)/);
    expect(prompt.user).toMatch(/\[r1\]/);
    const list = await call('GET', `/v1/clients/${w.clientA1}/reports`, w.users.managerA);
    expect(list.body[0]).toMatchObject({ id: reportId, status: 'ready', total: 12 });
  });

  it('el informe es inmutable y solo visible con reports.read en su organización', async () => {
    await expectSqlError(
      seed`update public.report_snapshots set status = 'failed' where id = ${reportId}`,
      '42501',
    );
    expect((await call('GET', `/v1/reports/${reportId}`, w.users.adminB)).status).toBe(404);
    const other = await asUser(
      seed,
      w.users.adminB,
      (tx) => tx`select id from public.report_snapshots`,
    );
    expect(other).toHaveLength(0);
    await expectSqlError(
      asUser(
        seed,
        w.users.adminA,
        (tx) => tx`
        insert into public.report_snapshots (organization_id, client_id, period_start, period_end, status, metrics)
        values (${w.orgA}, ${w.clientA1}, '2026-01-01', '2026-01-02', 'metrics_only', '{}')`,
      ),
      '42501',
    );
  });

  it('rechaza cifras inventadas: reintenta con el motivo y, si persiste, no guarda resumen', async () => {
    fake.setHandler('summary', () => ({
      headline: 'El 87 % de los clientes está encantado',
      summary: 'Hubo 12 interacciones.',
      findings: [],
      caveats: [],
    }));
    const before = fake.calls.length;
    const r = await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.managerA, {});
    expect(r.body.status).toBe('failed');
    expect(r.body.statusReason).toContain('87');
    expect(fake.calls.length - before).toBe(2);
    expect(fake.calls.at(-1)!.user).toContain('cifras que no están en las métricas');
    const [g] = await seed<{ status: string }[]>`
      select status from public.ai_generations where kind = 'summary' order by created_at desc limit 1`;
    expect(g!.status).toBe('rejected');
    const d = await call('GET', `/v1/reports/${r.body.id}`, w.users.managerA);
    expect(d.body.summary).toBeNull();
    expect(d.body.metrics.total).toBe(12);
  });

  it('rechaza porcentajes redactados como si fueran número de reseñas', async () => {
    const m = (await call('GET', `/v1/clients/${w.clientA1}/insights`, w.users.managerA)).body
      .metrics;
    const pctOnly = [m.positive_pct, m.negative_pct].find(
      (n: number) => n !== m.total && !Object.values(m.sentiment).includes(n),
    );
    expect(pctOnly).toBeDefined();
    fake.setHandler('summary', () => ({
      headline: `Hubo ${pctOnly} reseñas destacadas`,
      summary: 'Resumen.',
      findings: [],
      caveats: [],
    }));
    const before = fake.calls.length;
    const r = await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.managerA, {});
    expect(r.body.status).toBe('failed');
    expect(r.body.statusReason).toContain('sin el signo %');
    expect(fake.calls.length - before).toBe(2);
  });

  it('descarta hallazgos sin respaldo suficiente o de temas que no existen', async () => {
    fake.setHandler('summary', () => ({
      headline: 'Resumen',
      summary: 'Valoración media de 3.3.',
      findings: [
        {
          kind: 'issue',
          topic: 'servicio',
          title: 'Servicio',
          description: 'x',
          supporting_refs: ['r1'],
        },
        {
          kind: 'issue',
          topic: 'parking',
          title: 'Parking',
          description: 'x',
          supporting_refs: ['r1', 'r2', 'r3'],
        },
      ],
      caveats: [],
    }));
    const r = await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.managerA, {});
    expect(r.body.status).toBe('ready');
    const d = await call('GET', `/v1/reports/${r.body.id}`, w.users.managerA);
    expect(d.body.summary.findings).toHaveLength(0);
    expect(d.body.warnings.filter((x: string) => x.startsWith('Hallazgo descartado'))).toHaveLength(
      2,
    );
  });

  it('con menos de 10 interacciones no hay conclusiones de IA', async () => {
    const before = fake.calls.length;
    const r = await call('POST', `/v1/clients/${w.clientA2}/reports`, w.users.adminA, {});
    expect(r.body.status).toBe('insufficient_sample');
    expect(fake.calls.length).toBe(before);
  });

  it('crear informes exige poder editar el cliente (consume presupuesto de IA)', async () => {
    expect(
      (await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.adminB, {})).status,
    ).toBe(404);
  });

  it('sin IA configurada se guardan solo las métricas', async () => {
    app.deps.ai = null;
    const r = await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.managerA, {});
    expect(r.body.status).toBe('metrics_only');
  });

  it('hasta el DPA, el proveedor real no recibe periodos con reseñas reales', async () => {
    const realLike: AiProvider = { name: 'openai', generate: (q) => fake.generate(q) };
    app.deps.ai = { ...runtime, provider: realLike };
    await insert(w.clientA1, 1, {
      topics: ['servicio'],
      rating: 1,
      sentiment: 'negative',
      daysAgo: 1,
      simulated: false,
    });
    const before = fake.calls.length;
    const r = await call('POST', `/v1/clients/${w.clientA1}/reports`, w.users.managerA, {});
    expect(r.body.status).toBe('blocked');
    expect(r.body.statusReason).toMatch(/DPA/);
    expect(fake.calls.length).toBe(before);
  });
});
