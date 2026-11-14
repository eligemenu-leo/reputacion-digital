/**
 * Servicios de IA: clasificación (worker) y generación de borradores (API).
 *
 * Garantías:
 *  * La IA nunca publica: el borrador generado entra por `saveDraft` como
 *    cualquier otro y necesita la aprobación humana habitual.
 *  * Cada llamada (o intento bloqueado) deja una fila en `ai_generations`.
 *  * Antes de llamar se RESERVA el coste estimado bajo un bloqueo por
 *    organización; si supera el presupuesto mensual con corte activo, no se llama.
 *  * Hasta que se firme el DPA, el proveedor real solo recibe datos simulados.
 *  * La salida se valida con Zod y con reglas deterministas (enlaces, emails,
 *    teléfonos, expresiones prohibidas, longitud, repetición).
 */
import { createHash } from 'node:crypto';
import { AI_SIGNAL_TO_FLAG, AppError, SPECIALIST_FLAGS, type AiDraftVariant } from '@rep/shared';
import type { ZodType } from 'zod';
import { withService, type Sql, type Tx } from '../lib/db';
import { notify, QUEUES, type JobQueue } from '../domain/queue';
import {
  recordEvent,
  saveDraft,
  transition,
  type Actor,
  type InteractionRow,
} from '../domain/workflow';
import { AiProviderError, OpenAiProvider, type AiProvider, type AiRequest } from './provider';
import { FakeAiProvider } from './fake-provider';
import { DEFAULT_PRICES, costUsd, estimateCost, priceFor, type PriceTable } from './pricing';
import {
  buildClassifyUser,
  classificationJsonSchema,
  classificationSchema,
  CLASSIFY_PROMPT_VERSION,
  CLASSIFY_SYSTEM,
  type Classification,
} from './prompts/classify.v1';
import {
  buildDraftUser,
  draftJsonSchema,
  draftOutputSchema,
  DRAFT_PROMPT_VERSION,
  DRAFT_SYSTEM,
  type BrandContext,
  type DraftInput,
} from './prompts/draft.v2';
import { checkDraft, hasInvisibleChars, LENGTH_LIMITS } from './text';

export interface AiRuntime {
  provider: AiProvider;
  models: { classify: string; draft: string; summary: string };
  prices: PriceTable;
}

export interface AiDeps {
  sql: Sql;
  ai: AiRuntime | null;
  queue: JobQueue;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export const MAX_CLASSIFY_ATTEMPTS = 3;
const CLASSIFY_MAX_OUTPUT = 600;
const DRAFT_MAX_OUTPUT = 1200;
const DEFAULT_BUDGET_USD = 10;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createAiRuntime(
  config: {
    AI_PROVIDER: 'auto' | 'openai' | 'fake' | 'none';
    OPENAI_API_KEY?: string;
    OPENAI_BASE_URL: string;
    AI_MODEL_CLASSIFY: string;
    AI_MODEL_DRAFT: string;
    AI_MODEL_SUMMARY: string;
    AI_TIMEOUT_MS: number;
    AI_PRICES?: PriceTable;
  },
  make: {
    openai: (o: { apiKey: string; baseUrl: string; timeoutMs: number }) => AiProvider;
    fake: () => AiProvider;
  },
): AiRuntime | null {
  const prices = { ...DEFAULT_PRICES, ...(config.AI_PRICES ?? {}) };
  if (config.AI_PROVIDER === 'fake') {
    return {
      provider: make.fake(),
      models: { classify: 'fake-classify', draft: 'fake-draft', summary: 'fake-summary' },
      prices,
    };
  }
  if (config.AI_PROVIDER === 'none' || !config.OPENAI_API_KEY) return null;
  return {
    provider: make.openai({
      apiKey: config.OPENAI_API_KEY,
      baseUrl: config.OPENAI_BASE_URL,
      timeoutMs: config.AI_TIMEOUT_MS,
    }),
    models: {
      classify: config.AI_MODEL_CLASSIFY,
      draft: config.AI_MODEL_DRAFT,
      summary: config.AI_MODEL_SUMMARY,
    },
    prices,
  };
}

// -----------------------------------------------------------------------------
// Presupuesto y registro
// -----------------------------------------------------------------------------

export async function budgetStatus(tx: Tx, organizationId: string) {
  const [b] = await tx<{ monthlyLimitUsd: string; hardStop: boolean }[]>`
    select monthly_limit_usd, hard_stop from public.ai_budgets where organization_id = ${organizationId}`;
  const [s] = await tx<{ spent: string; calls: number }[]>`
    select coalesce(sum(case when status = 'running' then estimated_cost_usd else coalesce(cost_usd, 0) end), 0) as spent,
           count(*) filter (where status <> 'blocked')::int as calls
      from public.ai_generations
     where organization_id = ${organizationId} and created_at >= date_trunc('month', now())`;
  return {
    limitUsd: b ? Number(b.monthlyLimitUsd) : DEFAULT_BUDGET_USD,
    hardStop: b ? b.hardStop : true,
    spentUsd: Number(s?.spent ?? 0),
    calls: s?.calls ?? 0,
  };
}

export async function realDataAllowed(tx: Tx): Promise<boolean> {
  const [r] = await tx<{ value: { enabled?: boolean } }[]>`
    select value from public.platform_settings where key = 'ai_real_data_allowed'`;
  return r?.value?.enabled === true;
}

interface ReserveInput {
  organizationId: string;
  clientId: string;
  interactionId: string | null;
  kind: 'classification' | 'draft' | 'summary';
  model: string;
  promptVersion: string;
  brandVersionId?: string | null;
  variant?: AiDraftVariant | null;
  inputHash: string;
  promptChars: number;
  maxOutputTokens: number;
  createdBy: string | null;
}

type Reservation =
  | { ok: true; id: string; estimate: number }
  | { ok: false; id: string; reason: string; kind: 'budget' | 'price_unknown' };

/** Reserva el coste estimado o registra el bloqueo. Serializado por organización. */
export async function reserveGeneration(
  sql: Sql,
  ai: AiRuntime,
  r: ReserveInput,
): Promise<Reservation> {
  return withService(sql, null, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${'ai_budget:' + r.organizationId}, 0))`;
    const price = priceFor(ai.prices, r.model);
    const estimate = price ? estimateCost(price, r.promptChars, r.maxOutputTokens) : 0;
    let blocked: { reason: string; kind: 'budget' | 'price_unknown' } | null = null;
    if (!price) {
      blocked = {
        kind: 'price_unknown',
        reason: `No hay precio configurado para el modelo ${r.model}; no se usa para poder controlar el coste`,
      };
    } else {
      const b = await budgetStatus(tx, r.organizationId);
      if (b.hardStop && b.spentUsd + estimate > b.limitUsd) {
        blocked = {
          kind: 'budget',
          reason: `Presupuesto mensual de IA agotado (${b.spentUsd.toFixed(2)} de ${b.limitUsd.toFixed(2)} USD)`,
        };
      }
    }
    const [g] = await tx<{ id: string }[]>`
      insert into public.ai_generations
        (organization_id, client_id, interaction_id, kind, status, provider, model, prompt_version,
         brand_profile_version_id, variant, input_hash, estimated_cost_usd, error_kind, error_message, created_by, completed_at)
      values (${r.organizationId}, ${r.clientId}, ${r.interactionId}, ${r.kind}, ${blocked ? 'blocked' : 'running'},
              ${ai.provider.name}, ${r.model}, ${r.promptVersion}, ${r.brandVersionId ?? null}, ${r.variant ?? null},
              ${r.inputHash}, ${blocked ? 0 : estimate}, ${blocked?.kind ?? null}, ${blocked?.reason ?? null},
              ${r.createdBy}, ${blocked ? new Date() : null})
      returning id`;
    return blocked ? { ok: false, id: g!.id, ...blocked } : { ok: true, id: g!.id, estimate };
  });
}

interface CompleteInput {
  status: 'succeeded' | 'failed' | 'rejected';
  output?: unknown;
  warnings?: string[];
  errorKind?: string | null;
  errorMessage?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  attempts?: number;
}

export async function completeGeneration(
  sql: Sql,
  ai: AiRuntime,
  id: string,
  model: string,
  c: CompleteInput,
) {
  const price = priceFor(ai.prices, model);
  const cost =
    price && c.inputTokens != null ? costUsd(price, c.inputTokens, c.outputTokens ?? 0) : 0;
  await withService(
    sql,
    null,
    (tx) => tx`
    update public.ai_generations set status = ${c.status}, output = ${c.output === undefined ? null : tx.json(c.output as never)},
           warnings = ${c.warnings ?? []}, error_kind = ${c.errorKind ?? null},
           error_message = ${c.errorMessage?.slice(0, 1000) ?? null}, input_tokens = ${c.inputTokens ?? null},
           output_tokens = ${c.outputTokens ?? null}, cost_usd = ${cost}, latency_ms = ${c.latencyMs ?? null},
           attempts = ${c.attempts ?? 1}, completed_at = now()
     where id = ${id} and status = 'running'`,
  );
}

interface CallResult<T> {
  ok: true;
  value: T;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}
interface CallFailure {
  ok: false;
  error: AiProviderError;
  inputTokens: number;
  outputTokens: number;
}

/** Llama al proveedor y valida la salida. Nunca lanza: devuelve el error clasificado. */
export async function callStructured<T>(
  ai: AiRuntime,
  req: AiRequest,
  schema: ZodType<T>,
): Promise<CallResult<T> | CallFailure> {
  try {
    const res = await ai.provider.generate(req);
    const parsed = schema.safeParse(res.output);
    if (!parsed.success) {
      return {
        ok: false,
        error: new AiProviderError(
          'invalid_output',
          'La salida del modelo no cumple el esquema esperado',
        ),
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      };
    }
    return {
      ok: true,
      value: parsed.data,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: res.latencyMs,
    };
  } catch (err) {
    const e =
      err instanceof AiProviderError
        ? err
        : new AiProviderError('transient', 'Error inesperado del proveedor');
    return {
      ok: false,
      error: e,
      inputTokens: e.usage?.inputTokens ?? 0,
      outputTokens: e.usage?.outputTokens ?? 0,
    };
  }
}

// -----------------------------------------------------------------------------
// Clasificación (worker)
// -----------------------------------------------------------------------------

const PRIORITY_NUM = { low: 1, normal: 2, high: 3, critical: 4 } as const;

/** Reglas deterministas posteriores a la IA: nunca bajan la prioridad existente. */
export function applyClassificationRules(
  c: Classification,
  current: { priority: number; riskFlags: string[]; requiresSpecialist: boolean },
  rating: number | null,
  scale: number | null,
) {
  const flags = new Set(current.riskFlags);
  for (const s of c.risk_signals) flags.add(AI_SIGNAL_TO_FLAG[s]);
  const riskFlags = [...flags];
  const sensitive = riskFlags.some((f) => SPECIALIST_FLAGS.includes(f));
  let priority: number = Math.max(current.priority, PRIORITY_NUM[c.priority]);
  const normalized = rating == null ? null : (rating / (scale ?? 5)) * 5;
  if (normalized != null && normalized <= 2) priority = Math.max(priority, 3);
  if (sensitive) priority = 4;
  return {
    priority,
    riskFlags,
    requiresSpecialist: current.requiresSpecialist || sensitive,
    topics: [...new Set(c.topics.map((t) => t.toLowerCase().trim()).filter(Boolean))].slice(0, 8),
  };
}

interface ClassifyRow {
  id: string;
  organizationId: string;
  clientId: string;
  content: string | null;
  rating: string | null;
  ratingScale: number | null;
  provider: string;
  kind: string;
  language: string | null;
  contentHash: string;
  isSimulated: boolean;
  aiAttempts: number;
}

async function setAiStatus(
  sql: Sql,
  id: string,
  status: 'pending' | 'failed' | 'skipped',
  error: string | null,
) {
  await withService(
    sql,
    null,
    (tx) => tx`
    update public.external_interactions set ai_status = ${status}, ai_error = ${error}
     where id = ${id} and ai_status = 'running'`,
  );
}

export async function runClassify(deps: AiDeps, interactionId: string) {
  const { sql, ai } = deps;
  const claimed = await withService(sql, null, async (tx) => {
    const [r] = await tx<ClassifyRow[]>`
      update public.external_interactions set ai_status = 'running', ai_attempts = ai_attempts + 1, ai_error = null
       where id = ${interactionId} and ai_status = 'pending'
       returning id, organization_id, client_id, content, rating, rating_scale, provider, kind, language, content_hash,
                 is_simulated, ai_attempts`;
    if (!r) return null;
    const [c] = await tx<{ aiEnabled: boolean; sector: string | null }[]>`
      select ai_enabled, sector from public.clients where id = ${r.clientId}`;
    return {
      row: r,
      aiEnabled: c?.aiEnabled ?? false,
      sector: c?.sector ?? null,
      realOk: await realDataAllowed(tx),
    };
  });
  if (!claimed) return { status: 'skipped' as const };
  const { row } = claimed;
  if (!ai) {
    await setAiStatus(sql, row.id, 'skipped', 'IA no configurada');
    return { status: 'skipped' as const };
  }
  if (!claimed.aiEnabled) {
    await setAiStatus(sql, row.id, 'skipped', 'IA desactivada para este cliente');
    return { status: 'skipped' as const };
  }
  if (ai.provider.name !== 'fake' && !row.isSimulated && !claimed.realOk) {
    await setAiStatus(
      sql,
      row.id,
      'skipped',
      'Solo se analizan datos ficticios hasta firmar el DPA con el proveedor de IA',
    );
    return { status: 'skipped' as const };
  }

  const user = buildClassifyUser({
    content: row.content,
    rating: row.rating == null ? null : Number(row.rating),
    ratingScale: row.ratingScale,
    provider: row.provider,
    kind: row.kind,
    declaredLanguage: row.language,
    businessSector: claimed.sector,
  });
  const model = ai.models.classify;
  const inputHash = sha256(`${CLASSIFY_PROMPT_VERSION}|${model}|${CLASSIFY_SYSTEM}|${user}`);

  // Caché: misma entrada ya clasificada con éxito → se reutiliza sin coste.
  const cached = await withService(sql, null, async (tx) => {
    const [g] = await tx<{ id: string; output: unknown }[]>`
      select id, output from public.ai_generations
       where interaction_id = ${row.id} and kind = 'classification' and status = 'succeeded' and input_hash = ${inputHash}
       order by created_at desc limit 1`;
    return g ?? null;
  });

  let generationId: string;
  let classification: Classification;
  if (cached && classificationSchema.safeParse(cached.output).success) {
    generationId = cached.id;
    classification = classificationSchema.parse(cached.output);
  } else {
    const res = await reserveGeneration(sql, ai, {
      organizationId: row.organizationId,
      clientId: row.clientId,
      interactionId: row.id,
      kind: 'classification',
      model,
      promptVersion: CLASSIFY_PROMPT_VERSION,
      inputHash,
      promptChars: CLASSIFY_SYSTEM.length + user.length,
      maxOutputTokens: CLASSIFY_MAX_OUTPUT,
      createdBy: null,
    });
    if (!res.ok) {
      await setAiStatus(sql, row.id, 'failed', res.reason);
      return { status: 'blocked' as const, reason: res.reason };
    }
    generationId = res.id;
    const call = await callStructured(
      ai,
      {
        task: 'classification',
        model,
        system: CLASSIFY_SYSTEM,
        user,
        schemaName: 'classification_v1',
        jsonSchema: classificationJsonSchema as unknown as Record<string, unknown>,
        maxOutputTokens: CLASSIFY_MAX_OUTPUT,
      },
      classificationSchema,
    );
    if (!call.ok) {
      await completeGeneration(sql, ai, res.id, model, {
        status: 'failed',
        errorKind: call.error.kind,
        errorMessage: call.error.message,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
      });
      const retry =
        (call.error.retryable || call.error.kind === 'invalid_output') &&
        row.aiAttempts < MAX_CLASSIFY_ATTEMPTS;
      await setAiStatus(
        sql,
        row.id,
        retry ? 'pending' : 'failed',
        call.error.message.slice(0, 500),
      );
      if (retry) {
        await notify(deps.queue, QUEUES.classify, row.id, deps.log, {
          startAfterSeconds: 30 * row.aiAttempts,
        });
      }
      deps.log?.warn({ interactionId: row.id, kind: call.error.kind }, 'classification failed');
      return { status: 'failed' as const, error: call.error.kind, retry };
    }
    classification = call.value;
    await completeGeneration(sql, ai, res.id, model, {
      status: 'succeeded',
      output: call.value,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
    });
  }

  if (
    row.content &&
    hasInvisibleChars(row.content) &&
    !classification.risk_signals.includes('prompt_injection_attempt')
  ) {
    classification = {
      ...classification,
      risk_signals: [...classification.risk_signals, 'prompt_injection_attempt'],
    };
  }

  const applied = await withService(sql, null, async (tx) => {
    const [cur] = await tx<
      (InteractionRow & {
        aiStatus: string;
        contentHash: string;
        riskFlags: string[];
        language: string | null;
      })[]
    >`
      select id, organization_id, client_id, connected_account_id, provider, state, requires_specialist, assignee_id,
             priority, ai_status, content_hash, risk_flags, language
        from public.external_interactions where id = ${row.id} for update`;
    // Si el contenido cambió mientras se analizaba, se descarta: ya hay otro análisis pendiente.
    if (!cur || cur.aiStatus !== 'running' || cur.contentHash !== row.contentHash) return false;
    const r = applyClassificationRules(
      classification,
      cur,
      row.rating == null ? null : Number(row.rating),
      row.ratingScale,
    );
    await tx`
      update public.external_interactions set
        sentiment = ${classification.sentiment}, category = ${classification.category}, topics = ${r.topics},
        ai_confidence = ${Math.round(classification.confidence * 100) / 100},
        requires_response = ${classification.requires_response},
        language = coalesce(language, ${classification.language}),
        priority = ${r.priority}, risk_flags = ${r.riskFlags}, requires_specialist = ${r.requiresSpecialist},
        ai_status = 'done', ai_error = null, ai_classification_id = ${generationId}
       where id = ${cur.id}`;
    const data = {
      generationId,
      sentiment: classification.sentiment,
      category: classification.category,
      priority: r.priority,
      riskSignals: classification.risk_signals,
    };
    if (cur.state === 'new') {
      await transition(tx, cur, 'analysis_completed', { userId: null }, data);
    } else {
      await recordEvent(tx, cur, 'ai_classified', { userId: null }, { data });
    }
    return true;
  });
  return { status: applied ? ('done' as const) : ('stale' as const), generationId };
}

/** Marca para (re)análisis y avisa al worker después del commit. */
export async function requestClassification(tx: Tx, interactionId: string) {
  const r = await tx`
    update public.external_interactions set ai_status = 'pending', ai_attempts = 0, ai_error = null
     where id = ${interactionId} and ai_status <> 'running' returning id`;
  return r.length > 0;
}

/** Recupera análisis perdidos (aviso no enviado o worker caído). */
export async function sweepClassifications(deps: AiDeps, opts: { staleSeconds?: number } = {}) {
  const stale = opts.staleSeconds ?? 120;
  const ids = await withService(deps.sql, null, async (tx) => {
    await tx`
      update public.external_interactions
         set ai_status = case when ai_attempts >= ${MAX_CLASSIFY_ATTEMPTS} then 'failed'::public.ai_analysis_status
                              else 'pending'::public.ai_analysis_status end,
             ai_error = case when ai_attempts >= ${MAX_CLASSIFY_ATTEMPTS} then 'El análisis se interrumpió' else ai_error end
       where ai_status = 'running' and updated_at < now() - interval '10 minutes'`;
    const rows = await tx<{ id: string }[]>`
      select id from public.external_interactions
       where ai_status = 'pending' and updated_at < now() - make_interval(secs => ${stale}) order by updated_at limit 100`;
    return rows.map((r) => r.id);
  });
  for (const id of ids) await notify(deps.queue, QUEUES.classify, id, deps.log);
  return ids.length;
}

// -----------------------------------------------------------------------------
// Borradores (API, síncrono)
// -----------------------------------------------------------------------------

export interface DraftContext {
  row: InteractionRow;
  draft: DraftInput;
  isSimulated: boolean;
  riskFlags: string[];
  requiresSpecialist: boolean;
  hasInvisible: boolean;
}

/** Comprueba si se puede generar y reúne el contexto. Se llama dentro de withInteraction. */
export async function loadDraftContext(
  tx: Tx,
  row: InteractionRow,
  ai: AiRuntime | null,
  variant: AiDraftVariant,
): Promise<DraftContext> {
  if (!ai) throw new AppError('NOT_SUPPORTED', 'La IA no está configurada en este entorno');
  if (['publishing', 'published', 'discarded', 'closed_no_response'].includes(row.state)) {
    throw new AppError('CONFLICT', 'No se puede generar una respuesta en el estado actual');
  }
  const [i] = await tx<
    {
      content: string | null;
      rating: string | null;
      ratingScale: number | null;
      language: string | null;
      sentiment: string | null;
      category: string | null;
      riskFlags: string[];
      isSimulated: boolean;
      clientName: string;
      sector: string | null;
      aiEnabled: boolean;
      primaryLanguage: string | null;
    }[]
  >`
    select i.content, i.rating, i.rating_scale, i.language, i.sentiment, i.category, i.risk_flags, i.is_simulated,
           c.name as client_name, c.sector, c.ai_enabled, c.primary_language
      from public.external_interactions i join public.clients c on c.id = i.client_id
     where i.id = ${row.id}`;
  if (!i!.aiEnabled) throw new AppError('CONFLICT', 'La IA está desactivada para este cliente');
  if (ai.provider.name !== 'fake' && !i!.isSimulated && !(await realDataAllowed(tx))) {
    throw new AppError(
      'CONFLICT',
      'Hasta firmar el DPA con el proveedor de IA, la IA solo puede usarse con reseñas ficticias',
    );
  }
  const [b] = await tx<(Omit<BrandContext, 'versionId'> & { id: string })[]>`
    select v.id, v.version, v.tone, v.formality, v.address_form, v.response_language, v.recommended_expressions,
           v.forbidden_expressions, v.emoji_policy, v.preferred_length, v.approved_examples, v.extra_instructions,
           v.verified_business_info
      from public.brand_profiles p join public.brand_profile_versions v on v.id = p.current_version_id
     where p.client_id = ${row.clientId}`;
  if (!b) {
    throw new AppError(
      'CONFLICT',
      'Configura la personalidad de marca del cliente antes de generar con IA',
      {
        reason: 'brand_profile_missing',
      },
    );
  }
  const [current] = await tx<{ content: string }[]>`
    select content from public.response_drafts where interaction_id = ${row.id} order by version desc limit 1`;
  const recent = await tx<{ content: string }[]>`
    select content from public.publication_jobs
     where client_id = ${row.clientId} and status = 'published' and interaction_id <> ${row.id}
     order by completed_at desc nulls last limit 5`;
  const { id: versionId, ...brand } = b;
  return {
    row,
    isSimulated: i!.isSimulated,
    riskFlags: i!.riskFlags,
    requiresSpecialist: row.requiresSpecialist,
    hasInvisible: Boolean(i!.content && hasInvisibleChars(i!.content)),
    draft: {
      businessName: i!.clientName,
      sector: i!.sector,
      brand: {
        ...brand,
        versionId,
        approvedExamples: Array.isArray(brand.approvedExamples) ? brand.approvedExamples : [],
        verifiedBusinessInfo: brand.verifiedBusinessInfo ?? {},
        responseLanguage: brand.responseLanguage ?? i!.primaryLanguage ?? null,
      },
      content: i!.content,
      rating: i!.rating == null ? null : Number(i!.rating),
      ratingScale: i!.ratingScale,
      provider: row.provider,
      language: i!.language,
      sentiment: i!.sentiment,
      category: i!.category,
      riskFlags: i!.riskFlags,
      recentReplies: recent.map((r) => r.content),
      variant,
      currentDraft: current?.content ?? null,
    },
  };
}

export interface GeneratedDraft {
  generationId: string;
  reply: string;
  warnings: string[];
  toneApplied: string;
  usedFacts: string[];
}

/** Llama al modelo (hasta 2 intentos si las reglas rechazan el borrador) y registra la generación. */
export async function generateDraftText(
  deps: AiDeps,
  ctx: DraftContext,
  actor: Actor,
): Promise<GeneratedDraft> {
  const ai = deps.ai!;
  const model = ai.models.draft;
  const first = buildDraftUser(ctx.draft);
  const inputHash = sha256(`${DRAFT_PROMPT_VERSION}|${model}|${DRAFT_SYSTEM}|${first}`);
  const res = await reserveGeneration(deps.sql, ai, {
    organizationId: ctx.row.organizationId,
    clientId: ctx.row.clientId,
    interactionId: ctx.row.id,
    kind: 'draft',
    model,
    promptVersion: DRAFT_PROMPT_VERSION,
    brandVersionId: ctx.draft.brand.versionId,
    variant: ctx.draft.variant,
    inputHash,
    // Se reserva para dos intentos posibles.
    promptChars: (DRAFT_SYSTEM.length + first.length) * 2,
    maxOutputTokens: DRAFT_MAX_OUTPUT * 2,
    createdBy: actor.userId,
  });
  if (!res.ok) {
    throw new AppError(res.kind === 'budget' ? 'RATE_LIMITED' : 'CONFLICT', res.reason, {
      reason: res.kind,
    });
  }
  const brand = ctx.draft.brand;
  const verifiedText = Object.entries(brand.verifiedBusinessInfo)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  let feedback: string[] | undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  let latency = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1 ? first : buildDraftUser({ ...ctx.draft, retryFeedback: feedback });
    const call = await callStructured(
      ai,
      {
        task: 'draft',
        model,
        system: DRAFT_SYSTEM,
        user,
        schemaName: 'draft_v1',
        jsonSchema: draftJsonSchema as unknown as Record<string, unknown>,
        maxOutputTokens: DRAFT_MAX_OUTPUT,
      },
      draftOutputSchema,
    );
    tokensIn += call.inputTokens;
    tokensOut += call.outputTokens;
    if (!call.ok) {
      await completeGeneration(deps.sql, ai, res.id, model, {
        status: 'failed',
        errorKind: call.error.kind,
        errorMessage: call.error.message,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        attempts: attempt,
      });
      throw new AppError(
        call.error.kind === 'rate_limited' ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE',
        call.error.kind === 'auth'
          ? 'El proveedor de IA rechazó la clave configurada'
          : 'No se pudo generar el borrador. Inténtalo de nuevo en unos minutos.',
        { reason: call.error.kind },
      );
    }
    latency += call.latencyMs;
    const reply = call.value.reply.trim();
    const reasons = checkDraft({
      reply,
      verifiedText,
      forbiddenExpressions: brand.forbiddenExpressions,
      maxChars: LENGTH_LIMITS[brand.preferredLength] + 150,
      recentReplies: ctx.draft.recentReplies,
    });
    const current = ctx.draft.currentDraft?.trim();
    if (ctx.draft.variant === 'shorter' && current && reply.length > current.length * 0.85) {
      reasons.push(
        `La variante «Más breve» debe ser claramente más corta que el borrador actual (${current.length} caracteres)`,
      );
    }
    if (reasons.length === 0) {
      const known = new Set(Object.keys(brand.verifiedBusinessInfo));
      const warnings = [...call.value.warnings];
      if (ctx.requiresSpecialist) {
        warnings.push('Esta interacción requiere revisión especializada antes de aprobar.');
      }
      if (ctx.riskFlags.includes('prompt_injection') || ctx.hasInvisible) {
        warnings.push(
          'La reseña contiene texto que intenta dar instrucciones: se ha tratado como dato, revisa la respuesta con atención.',
        );
      }
      if (ctx.isSimulated) warnings.push('Reseña ficticia del simulador.');
      if (ai.provider.name === 'fake')
        warnings.push('Borrador de la IA simulada (reglas de prueba, no un modelo real).');
      const usedFacts = call.value.used_facts.filter((f) => known.has(f));
      await completeGeneration(deps.sql, ai, res.id, model, {
        status: 'succeeded',
        output: { ...call.value, reply, used_facts: usedFacts },
        warnings: [...new Set(warnings)],
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        latencyMs: latency,
        attempts: attempt,
      });
      return {
        generationId: res.id,
        reply,
        warnings: [...new Set(warnings)],
        toneApplied: call.value.tone_applied,
        usedFacts,
      };
    }
    feedback = reasons;
    if (attempt === 2) {
      await completeGeneration(deps.sql, ai, res.id, model, {
        status: 'rejected',
        output: call.value,
        warnings: reasons,
        errorKind: 'validation',
        errorMessage: reasons.join('; '),
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        latencyMs: latency,
        attempts: attempt,
      });
    }
  }
  throw new AppError(
    'CONFLICT',
    'La IA no consiguió un borrador que cumpla las reglas de la marca. Redáctalo a mano o inténtalo de nuevo.',
    { reason: 'validation', reasons: feedback },
  );
}

/** Guarda el borrador generado como nueva versión (fuente «ai»). */
export async function saveAiDraft(tx: Tx, row: InteractionRow, g: GeneratedDraft, actor: Actor) {
  return saveDraft(tx, row, g.reply, actor, 'ai', g.generationId);
}

/** Crea el runtime de IA a partir de la configuración (OpenAI, simulado o ninguno). */
export function aiRuntimeFromConfig(config: Parameters<typeof createAiRuntime>[0]) {
  return createAiRuntime(config, {
    openai: (o) => new OpenAiProvider(o),
    fake: () => new FakeAiProvider(),
  });
}
