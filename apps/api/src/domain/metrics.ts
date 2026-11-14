/**
 * Métricas OBSERVADAS de un cliente en un periodo. Las calcula el backend con
 * SQL (nunca la IA) y son la única fuente de cifras de los informes.
 * Las proporciones se dan ya en porcentaje entero (`*_pct`) y las medias con
 * un decimal, para que el resumen de IA no tenga que calcular nada.
 */
import type { Tx } from '../lib/db';

export interface TopicMetric {
  topic: string;
  count: number;
  rating_avg: number | null;
  negative_pct: number;
  positive_pct: number;
  previous_count: number;
}

export interface Metrics {
  period: { from: string; to: string; days: number };
  previous_period: { from: string; to: string };
  total: number;
  with_text: number;
  simulated: number;
  rating_count: number;
  rating_avg: number | null;
  rating_distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  sentiment: {
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    unknown: number;
  };
  negative_pct: number;
  positive_pct: number;
  responded: number;
  response_rate_pct: number;
  median_response_hours: number | null;
  risk_flagged: number;
  specialist_required: number;
  by_provider: { provider: string; count: number; rating_avg: number | null }[];
  topics: TopicMetric[];
  previous: { total: number; rating_avg: number | null; negative_pct: number };
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const r1 = (v: string | number | null) => (v == null ? null : Math.round(Number(v) * 10) / 10);

function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** `from` y `to` son fechas (YYYY-MM-DD) inclusivas, interpretadas en UTC. */
export async function computeMetrics(
  tx: Tx,
  clientId: string,
  from: string,
  to: string,
): Promise<Metrics> {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const range = (f: string, t: string) =>
    tx`i.client_id = ${clientId} and i.original_created_at >= ${f}::date and i.original_created_at < ${t}::date + 1`;

  const [m] = await tx<
    {
      total: number;
      withText: number;
      simulated: number;
      ratingCount: number;
      ratingAvg: string | null;
      r1: number;
      r2: number;
      r3: number;
      r4: number;
      r5: number;
      positive: number;
      negative: number;
      neutral: number;
      mixed: number;
      unknown: number;
      responded: number;
      medianHours: string | null;
      riskFlagged: number;
      specialist: number;
    }[]
  >`
    select count(*)::int as total,
           count(*) filter (where coalesce(btrim(content), '') <> '')::int as with_text,
           count(*) filter (where is_simulated)::int as simulated,
           count(rating)::int as rating_count,
           avg(rating / coalesce(rating_scale, 5) * 5) as rating_avg,
           count(*) filter (where round(rating / coalesce(rating_scale, 5) * 5) <= 1)::int as r1,
           count(*) filter (where round(rating / coalesce(rating_scale, 5) * 5) = 2)::int as r2,
           count(*) filter (where round(rating / coalesce(rating_scale, 5) * 5) = 3)::int as r3,
           count(*) filter (where round(rating / coalesce(rating_scale, 5) * 5) = 4)::int as r4,
           count(*) filter (where round(rating / coalesce(rating_scale, 5) * 5) = 5)::int as r5,
           count(*) filter (where sentiment = 'positive')::int as positive,
           count(*) filter (where sentiment = 'negative')::int as negative,
           count(*) filter (where sentiment = 'neutral')::int as neutral,
           count(*) filter (where sentiment = 'mixed')::int as mixed,
           count(*) filter (where sentiment is null)::int as unknown,
           count(*) filter (where responded_at is not null or existing_reply_content is not null)::int as responded,
           percentile_cont(0.5) within group (
             order by extract(epoch from (responded_at - original_created_at)) / 3600)
             filter (where responded_at is not null) as median_hours,
           count(*) filter (where cardinality(risk_flags) > 0)::int as risk_flagged,
           count(*) filter (where requires_specialist)::int as specialist
      from public.external_interactions i where ${range(from, to)}`;

  const byProvider = await tx<{ provider: string; count: number; ratingAvg: string | null }[]>`
    select provider, count(*)::int as count, avg(rating / coalesce(rating_scale, 5) * 5) as rating_avg
      from public.external_interactions i where ${range(from, to)}
     group by provider order by count desc`;

  const topics = await tx<
    {
      topic: string;
      count: number;
      ratingAvg: string | null;
      negative: number;
      positive: number;
      previousCount: number;
    }[]
  >`
    with cur as (
      select t.topic, i.rating, i.rating_scale, i.sentiment
        from public.external_interactions i cross join lateral unnest(i.topics) as t(topic)
       where ${range(from, to)}
    ), prev as (
      select t.topic, count(*)::int as n
        from public.external_interactions i cross join lateral unnest(i.topics) as t(topic)
       where ${range(prevFrom, prevTo)} group by t.topic
    )
    select cur.topic, count(*)::int as count, avg(rating / coalesce(rating_scale, 5) * 5) as rating_avg,
           count(*) filter (where sentiment in ('negative', 'mixed'))::int as negative,
           count(*) filter (where sentiment = 'positive')::int as positive,
           coalesce(max(prev.n), 0)::int as previous_count
      from cur left join prev on prev.topic = cur.topic
     group by cur.topic order by count desc, cur.topic limit 15`;

  const [p] = await tx<{ total: number; ratingAvg: string | null; negative: number }[]>`
    select count(*)::int as total, avg(rating / coalesce(rating_scale, 5) * 5) as rating_avg,
           count(*) filter (where sentiment in ('negative', 'mixed'))::int as negative
      from public.external_interactions i where ${range(prevFrom, prevTo)}`;

  const x = m!;
  return {
    period: { from, to, days },
    previous_period: { from: prevFrom, to: prevTo },
    total: x.total,
    with_text: x.withText,
    simulated: x.simulated,
    rating_count: x.ratingCount,
    rating_avg: r1(x.ratingAvg),
    rating_distribution: { '1': x.r1, '2': x.r2, '3': x.r3, '4': x.r4, '5': x.r5 },
    sentiment: {
      positive: x.positive,
      negative: x.negative,
      neutral: x.neutral,
      mixed: x.mixed,
      unknown: x.unknown,
    },
    negative_pct: pct(x.negative + x.mixed, x.total),
    positive_pct: pct(x.positive, x.total),
    responded: x.responded,
    response_rate_pct: pct(x.responded, x.total),
    median_response_hours: r1(x.medianHours),
    risk_flagged: x.riskFlagged,
    specialist_required: x.specialist,
    by_provider: byProvider.map((b) => ({
      provider: b.provider,
      count: b.count,
      rating_avg: r1(b.ratingAvg),
    })),
    topics: topics.map((t) => ({
      topic: t.topic,
      count: t.count,
      rating_avg: r1(t.ratingAvg),
      negative_pct: pct(t.negative, t.count),
      positive_pct: pct(t.positive, t.count),
      previous_count: t.previousCount,
    })),
    previous: {
      total: p!.total,
      rating_avg: r1(p!.ratingAvg),
      negative_pct: pct(p!.negative, p!.total),
    },
  };
}

/** Todos los números que aparecen en las métricas (y en las fechas del periodo). */
export function allowedNumbers(m: Metrics): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === 'number') out.add(v);
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
      v.split('-').forEach((s) => out.add(Number(s)));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(m);
  for (const k of ['1', '2', '3', '4', '5']) out.add(Number(k)); // escala de estrellas
  return out;
}

/** Cifras del texto que no existen en las métricas (validación del resumen). */
export function unknownNumbers(text: string, allowed: Set<number>): string[] {
  const found = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(found.filter((s) => !allowed.has(Number(s.replace(',', '.')))))];
}

/**
 * Números que solo existen en las métricas como porcentaje (`*_pct`) y que el
 * texto usa sin «%» o «por ciento»: se leerían como recuentos («42 positivas»).
 */
export function percentWithoutSign(text: string, m: Metrics): string[] {
  const pcts = new Set<number>();
  const others = new Set<number>();
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'number') (key.endsWith('_pct') ? pcts : others).add(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(m);
  const out: string[] = [];
  for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = Number(match[0].replace(',', '.'));
    if (!pcts.has(n) || others.has(n)) continue;
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 12);
    if (!/^\s?(%|por ?ciento)/i.test(after)) out.push(match[0]);
  }
  return out;
}
