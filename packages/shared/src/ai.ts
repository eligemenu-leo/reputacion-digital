import { z } from 'zod';

/** Variantes que el gestor puede pedir al generar un borrador con IA. */
export const AI_DRAFT_VARIANTS = [
  'initial',
  'another',
  'shorter',
  'warmer',
  'more_formal',
] as const;
export type AiDraftVariant = (typeof AI_DRAFT_VARIANTS)[number];

export const AI_DRAFT_VARIANT_LABELS_ES: Record<AiDraftVariant, string> = {
  initial: 'Generar con IA',
  another: 'Otra versión',
  shorter: 'Más breve',
  warmer: 'Más cercana',
  more_formal: 'Más formal',
};

export const aiDraftRequestSchema = z.object({
  variant: z.enum(AI_DRAFT_VARIANTS).default('initial'),
});
export type AiDraftRequest = z.infer<typeof aiDraftRequestSchema>;

export const aiBudgetUpdateSchema = z.object({
  monthlyLimitUsd: z.number().min(0).max(100000),
  hardStop: z.boolean(),
});

export const SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];
export const SENTIMENT_LABELS_ES: Record<Sentiment, string> = {
  positive: 'Positiva',
  negative: 'Negativa',
  neutral: 'Neutra',
  mixed: 'Mixta',
};

export const CATEGORIES = [
  'praise',
  'complaint',
  'constructive_criticism',
  'question',
  'neutral',
  'inappropriate',
  'sensitive_claim',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS_ES: Record<Category, string> = {
  praise: 'Elogio',
  complaint: 'Queja',
  constructive_criticism: 'Crítica constructiva',
  question: 'Pregunta',
  neutral: 'Neutra',
  inappropriate: 'Inapropiada',
  sensitive_claim: 'Reclamación delicada',
};

/** Señales de riesgo que devuelve la clasificación (contrato del modelo). */
export const AI_RISK_SIGNALS = [
  'food_safety',
  'health',
  'discrimination',
  'legal_threat',
  'safety',
  'personal_data',
  'prompt_injection_attempt',
] as const;
export type AiRiskSignal = (typeof AI_RISK_SIGNALS)[number];

/** Correspondencia con las marcas de riesgo de la bandeja (mismas que el triaje determinista). */
export const AI_SIGNAL_TO_FLAG: Record<AiRiskSignal, string> = {
  food_safety: 'food_safety',
  health: 'health',
  discrimination: 'discrimination',
  legal_threat: 'legal',
  safety: 'safety',
  personal_data: 'personal_data',
  prompt_injection_attempt: 'prompt_injection',
};
/** Señales que exigen revisión especializada antes de aprobar. */
export const SPECIALIST_FLAGS = ['legal', 'health', 'food_safety', 'safety', 'discrimination'];

export const AI_STATUS_LABELS_ES = {
  not_requested: 'Sin analizar',
  pending: 'Análisis en cola',
  running: 'Analizando…',
  done: 'Analizada por IA',
  failed: 'Error en el análisis',
  skipped: 'IA no aplicada',
} as const;
export type AiStatus = keyof typeof AI_STATUS_LABELS_ES;

/** `confidence` es una estimación del modelo, no una probabilidad calibrada. */
export function confidenceLabel(c: number | null | undefined): 'baja' | 'media' | 'alta' | null {
  if (c == null) return null;
  return c >= 0.8 ? 'alta' : c >= 0.5 ? 'media' : 'baja';
}

// -----------------------------------------------------------------------------
// Personalidad de marca (cada guardado crea una versión inmutable)
// -----------------------------------------------------------------------------
const phrase = z.string().trim().min(1).max(200);
export const brandVersionInputSchema = z
  .object({
    tone: z.string().trim().max(300).nullable().default(null),
    formality: z.number().int().min(1).max(5).nullable().default(3),
    addressForm: z.enum(['tu', 'usted', 'auto']).default('auto'),
    responseLanguage: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Código de idioma no válido (p. ej. es o es-ES)')
      .nullable()
      .default(null),
    recommendedExpressions: z.array(phrase).max(30).default([]),
    forbiddenExpressions: z.array(phrase).max(50).default([]),
    emojiPolicy: z.enum(['none', 'moderate', 'free']).default('none'),
    preferredLength: z.enum(['short', 'medium', 'long']).default('medium'),
    approvedExamples: z
      .array(z.object({ text: z.string().trim().min(1).max(1500) }))
      .max(10)
      .default([]),
    extraInstructions: z.string().trim().max(4000).nullable().default(null),
    /** Hechos verificados que la IA puede citar (clave → valor). Solo esto se considera cierto. */
    verifiedBusinessInfo: z
      .record(
        z
          .string()
          .trim()
          .regex(/^[\p{L}\p{N} _-]{1,60}$/u, 'Clave no válida'),
        z.string().trim().min(1).max(500),
      )
      .refine((o) => Object.keys(o).length <= 40, 'Máximo 40 datos verificados')
      .default({}),
    changeNote: z.string().trim().max(500).nullable().default(null),
  })
  .strict();
export type BrandVersionInput = z.infer<typeof brandVersionInputSchema>;
