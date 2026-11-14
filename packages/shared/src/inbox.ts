import { z } from 'zod';
import { INTERACTION_STATES } from './interaction-state';
import { uuidSchema } from './schemas';

export const PRIORITY_LABELS_ES: Record<1 | 2 | 3 | 4, string> = {
  1: 'Baja',
  2: 'Normal',
  3: 'Alta',
  4: 'Crítica',
};

export const PROVIDER_LABELS_ES: Record<string, string> = {
  google_business_profile: 'Google',
  facebook_page: 'Facebook',
  instagram_business: 'Instagram',
  web_search: 'Web',
  rss: 'RSS',
  simulator: 'Simulador',
};

export const CONNECTION_STATUS_LABELS_ES = {
  connected: 'Conectada',
  pending_authorization: 'Pendiente de autorización',
  syncing: 'Sincronizando',
  insufficient_access: 'Acceso insuficiente',
  credentials_expired: 'Credenciales caducadas',
  temporary_error: 'Error temporal',
  disconnected: 'Desconectada',
} as const;
export type ConnectionStatus = keyof typeof CONNECTION_STATUS_LABELS_ES;

export const interactionStateSchema = z.enum(INTERACTION_STATES);

// La entrada de los elementos puede ser string (p. ej. z.coerce.number()), de ahí el `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const csv = <T extends z.ZodType<unknown, any>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item).max(20));

export const inboxQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  clientId: uuidSchema.optional(),
  provider: z.string().max(40).optional(),
  state: csv(interactionStateSchema).optional(),
  priority: csv(z.coerce.number().int().min(1).max(4)).optional(),
  ratingMax: z.coerce.number().min(0).max(5).optional(),
  ratingMin: z.coerce.number().min(0).max(5).optional(),
  assignee: z.union([uuidSchema, z.literal('me'), z.literal('none')]).optional(),
  unanswered: z.coerce.boolean().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  sort: z.enum(['date', 'priority', 'rating']).default('date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const draftInputSchema = z
  .object({ content: z.string().trim().min(1, 'La respuesta no puede estar vacía').max(5000) })
  .strict();

export const decisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject', 'return']),
    note: z.string().trim().max(2000).optional(),
    /** Confirmación explícita de revisión especializada (obligatoria si la interacción la requiere). */
    specialistReviewed: z.boolean().default(false),
    /** Hash del texto que el aprobador ha visto: si cambió entretanto, la aprobación se rechaza. */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const interactionActionSchema = z
  .object({
    action: z.enum([
      'mark_needs_response',
      'discard',
      'close_without_response',
      'reopen',
      'retry_publish',
    ]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const interactionPatchSchema = z
  .object({
    assigneeId: uuidSchema.nullable().optional(),
    priority: z.number().int().min(1).max(4).optional(),
    requiresSpecialist: z.boolean().optional(),
  })
  .strict();

export const batchSchema = z
  .object({
    ids: z.array(uuidSchema).min(1).max(100),
    // Solo acciones seguras por lotes: nunca aprobar ni publicar en bloque.
    action: z.enum([
      'assign',
      'set_priority',
      'discard',
      'close_without_response',
      'mark_needs_response',
    ]),
    assigneeId: uuidSchema.nullable().optional(),
    priority: z.number().int().min(1).max(4).optional(),
  })
  .strict();

export const simulatorConnectionSchema = z
  .object({
    clientId: uuidSchema,
    locationId: uuidSchema.nullable().optional(),
    displayName: z.string().trim().min(1).max(200).default('Simulador de reseñas'),
    publishMode: z
      .enum(['ok', 'error', 'ambiguous', 'rate_limited', 'credentials_expired'])
      .default('ok'),
    syncMode: z.enum(['ok', 'error', 'credentials_expired']).default('ok'),
  })
  .strict();

export const simulatorConfigSchema = simulatorConnectionSchema
  .pick({ publishMode: true, syncMode: true })
  .partial()
  .strict();
