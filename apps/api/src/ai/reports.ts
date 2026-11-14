/**
 * Informes: métricas observadas (SQL) + resumen y hallazgos de IA.
 *
 * Reglas (docs/AI_DESIGN.md · Servicios 3 y 4):
 *  * Las cifras las calcula el backend; el texto de la IA no puede contener
 *    ningún número que no esté en las métricas (si no, reintento y rechazo).
 *  * Sin conclusiones de IA si la muestra es menor que el umbral (10).
 *  * Cada hallazgo se apoya en ≥ 3 interacciones del tema, que se guardan.
 *  * Hasta el DPA, el proveedor real no recibe ejemplos de reseñas reales.
 */
import { createHash } from 'node:crypto';
import { AppError } from '@rep/shared';
import { withService, type Tx } from '../lib/db';
import {
  computeMetrics,
  allowedNumbers,
  percentWithoutSign,
  unknownNumbers,
  type Metrics,
} from '../domain/metrics';
import {
  callStructured,
  completeGeneration,
  realDataAllowed,
  reserveGeneration,
  type AiDeps,
} from './service';
import {
  buildSummaryUser,
  summaryJsonSchema,
  summaryOutputSchema,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SYSTEM,
  type SummaryExample,
  type SummaryOutput,
} from './prompts/summary.v2';

export const MIN_SAMPLE = 10;
export const MIN_SUPPORT = 3;
const SUMMARY_MAX_OUTPUT = 1500;
const EXAMPLES_PER_TOPIC = 6;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ReportFinding {
  kind: 'strength' | 'issue' | 'watch';
  topic: string;
  title: string;
  description: string;
  supportingInteractionIds: string[];
}
export interface ReportSummary {
  headline: string;
  summary: string;
  findings: ReportFinding[];
  caveats: string[];
  provider: 'openai' | 'fake';
  model: string;
}

async function loadExamples(tx: Tx, clientId: string, m: Metrics, onlySimulated: boolean) {
  // Ejemplos de los temas principales (aunque no lleguen al mínimo, sirven de
  // contexto) y, además, las reseñas recientes con texto que no tengan tema.
  const topics = m.topics.slice(0, 6).map((t) => t.topic);
  const rows = await tx<
    {
      id: string;
      topics: string[];
      rating: string | null;
      ratingScale: number | null;
      sentiment: string | null;
      content: string;
    }[]
  >`
    select id, topics, rating, rating_scale, sentiment, content from (
      select i.id, i.topics, i.rating, i.rating_scale, i.sentiment, i.content, i.original_created_at,
             coalesce(t.topic, '') as topic,
             row_number() over (partition by coalesce(t.topic, '') order by i.original_created_at desc) as rn
        from public.external_interactions i
        left join lateral unnest(i.topics) as t(topic) on t.topic = any(${topics}::text[])
       where i.client_id = ${clientId}
         and i.original_created_at >= ${m.period.from}::date and i.original_created_at < ${m.period.to}::date + 1
         and coalesce(btrim(i.content), '') <> ''
         and (${onlySimulated} = false or i.is_simulated)
    ) x where rn <= ${EXAMPLES_PER_TOPIC}
    order by topic <> '' desc, original_created_at desc`;
  const seen = new Map<string, SummaryExample>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.set(r.id, {
      ref: `r${seen.size + 1}`,
      interactionId: r.id,
      topics: r.topics,
      rating:
        r.rating == null
          ? null
          : Math.round((Number(r.rating) / (r.ratingScale ?? 5)) * 5 * 10) / 10,
      sentiment: r.sentiment,
      content: r.content,
    });
  }
  return [...seen.values()];
}

/** Valida cifras y respaldo. Devuelve motivos de rechazo y los hallazgos aceptados. */
export function validateSummary(out: SummaryOutput, m: Metrics, examples: SummaryExample[]) {
  const allowed = allowedNumbers(m);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const texts = [
    out.headline,
    out.summary,
    ...out.caveats,
    ...out.findings.flatMap((f) => [f.title, f.description]),
  ];
  const bad = [...new Set(texts.flatMap((t) => unknownNumbers(t, allowed)))];
  if (bad.length) reasons.push(`Contiene cifras que no están en las métricas: ${bad.join(', ')}`);
  const pctMisuse = [...new Set(texts.flatMap((t) => percentWithoutSign(t, m)))];
  if (pctMisuse.length) {
    reasons.push(
      `Usa porcentajes sin el signo % (parecen recuentos): ${pctMisuse.join(', ')}. Escribe «N %» o usa los recuentos de sentiment`,
    );
  }
  const byRef = new Map(examples.map((e) => [e.ref, e]));
  const topics = new Set(m.topics.map((t) => t.topic));
  const findings: ReportFinding[] = [];
  for (const f of out.findings) {
    const ids = [
      ...new Set(
        f.supporting_refs
          .map((r) => byRef.get(r.trim()))
          .filter((e): e is SummaryExample => Boolean(e && e.topics.includes(f.topic)))
          .map((e) => e.interactionId),
      ),
    ];
    if (!topics.has(f.topic) || ids.length < MIN_SUPPORT) {
      warnings.push(`Hallazgo descartado por falta de respaldo: «${f.title}»`);
      continue;
    }
    findings.push({
      kind: f.kind,
      topic: f.topic,
      title: f.title,
      description: f.description,
      supportingInteractionIds: ids,
    });
  }
  return { reasons, warnings, findings };
}

export interface ReportResult {
  id: string;
  status: 'ready' | 'metrics_only' | 'insufficient_sample' | 'blocked' | 'failed';
  statusReason: string | null;
}

/**
 * Crea un informe inmutable. Las métricas se guardan siempre; el resumen
 * solo si hay IA, muestra suficiente, presupuesto y el texto supera la validación.
 */
export async function createReport(
  deps: AiDeps,
  ctx: { organizationId: string; clientId: string; clientName: string; userId: string },
  from: string,
  to: string,
): Promise<ReportResult> {
  const { sql, ai } = deps;
  const prep = await withService(sql, null, async (tx) => {
    const metrics = await computeMetrics(tx, ctx.clientId, from, to);
    const [c] = await tx<
      { aiEnabled: boolean }[]
    >`select ai_enabled from public.clients where id = ${ctx.clientId}`;
    const realOk = await realDataAllowed(tx);
    const external = Boolean(ai && ai.provider.name !== 'fake');
    const hasReal = metrics.total > metrics.simulated;
    const examples =
      ai && c?.aiEnabled && metrics.total >= MIN_SAMPLE
        ? await loadExamples(tx, ctx.clientId, metrics, external && !realOk)
        : [];
    return {
      metrics,
      aiEnabled: c?.aiEnabled ?? false,
      blockedByDpa: external && hasReal && !realOk,
      examples,
    };
  });
  const { metrics, examples } = prep;

  const save = (
    status: ReportResult['status'],
    reason: string | null,
    extra: { summary?: ReportSummary; warnings?: string[]; generationId?: string | null } = {},
  ) =>
    withService(sql, null, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into public.report_snapshots
          (organization_id, client_id, period_start, period_end, status, metrics, summary, warnings, status_reason,
           ai_generation_id, created_by)
        values (${ctx.organizationId}, ${ctx.clientId}, ${from}, ${to}, ${status}, ${tx.json(metrics as never)},
                ${extra.summary ? tx.json(extra.summary as never) : null}, ${extra.warnings ?? []}, ${reason},
                ${extra.generationId ?? null}, ${ctx.userId})
        returning id`;
      return { id: r!.id, status, statusReason: reason };
    });

  if (!ai) return save('metrics_only', 'La IA no está configurada en este entorno');
  if (!prep.aiEnabled) return save('metrics_only', 'La IA está desactivada para este cliente');
  if (metrics.total < MIN_SAMPLE) {
    return save(
      'insufficient_sample',
      `Muestra insuficiente para conclusiones: ${metrics.total} interacciones (mínimo ${MIN_SAMPLE})`,
    );
  }
  if (prep.blockedByDpa) {
    return save(
      'blocked',
      'El periodo incluye reseñas reales y la IA solo puede procesar datos ficticios hasta firmar el DPA',
    );
  }

  const user = buildSummaryUser({
    businessName: ctx.clientName,
    metrics,
    examples,
    isSimulated: metrics.simulated === metrics.total,
  });
  const model = ai.models.summary;
  const res = await reserveGeneration(sql, ai, {
    organizationId: ctx.organizationId,
    clientId: ctx.clientId,
    interactionId: null,
    kind: 'summary',
    model,
    promptVersion: SUMMARY_PROMPT_VERSION,
    inputHash: sha256(`${SUMMARY_PROMPT_VERSION}|${model}|${SUMMARY_SYSTEM}|${user}`),
    promptChars: (SUMMARY_SYSTEM.length + user.length) * 2,
    maxOutputTokens: SUMMARY_MAX_OUTPUT * 2,
    createdBy: ctx.userId,
  });
  if (!res.ok) return save('blocked', res.reason);

  let tokensIn = 0;
  let tokensOut = 0;
  let latency = 0;
  let feedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? user
        : `${user}\n\nTu propuesta anterior se rechazó por: ${feedback.join('; ')}. Corrígelo.`;
    const call = await callStructured(
      ai,
      {
        task: 'summary',
        model,
        system: SUMMARY_SYSTEM,
        user: prompt,
        schemaName: 'summary_v2',
        jsonSchema: summaryJsonSchema as unknown as Record<string, unknown>,
        maxOutputTokens: SUMMARY_MAX_OUTPUT,
      },
      summaryOutputSchema,
    );
    tokensIn += call.inputTokens;
    tokensOut += call.outputTokens;
    if (!call.ok) {
      await completeGeneration(sql, ai, res.id, model, {
        status: 'failed',
        errorKind: call.error.kind,
        errorMessage: call.error.message,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        attempts: attempt,
      });
      return save('failed', 'No se pudo generar el resumen. Las métricas se han guardado.', {
        generationId: res.id,
      });
    }
    latency += call.latencyMs;
    const v = validateSummary(call.value, metrics, examples);
    if (!v.reasons.length) {
      const warnings = [...v.warnings];
      if (metrics.simulated === metrics.total)
        warnings.push('Informe basado en reseñas ficticias del simulador.');
      if (ai.provider.name === 'fake')
        warnings.push('Resumen de la IA simulada (reglas de prueba, no un modelo real).');
      await completeGeneration(sql, ai, res.id, model, {
        status: 'succeeded',
        output: call.value,
        warnings,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        latencyMs: latency,
        attempts: attempt,
      });
      return save('ready', null, {
        summary: {
          headline: call.value.headline,
          summary: call.value.summary,
          findings: v.findings,
          caveats: call.value.caveats,
          provider: ai.provider.name,
          model,
        },
        warnings,
        generationId: res.id,
      });
    }
    feedback = v.reasons;
    if (attempt === 2) {
      await completeGeneration(sql, ai, res.id, model, {
        status: 'rejected',
        output: call.value,
        warnings: v.reasons,
        errorKind: 'validation',
        errorMessage: v.reasons.join('; '),
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        latencyMs: latency,
        attempts: attempt,
      });
    }
  }
  return save('failed', `El resumen de la IA no superó la validación: ${feedback.join('; ')}`, {
    generationId: res.id,
  });
}

export function assertPeriod(from: string, to: string) {
  if (Date.parse(to) < Date.parse(from))
    throw new AppError('VALIDATION', 'La fecha final es anterior a la inicial');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) {
    throw new AppError('VALIDATION', 'El periodo no puede superar un año');
  }
}
