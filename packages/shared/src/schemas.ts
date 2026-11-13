import { z } from 'zod';

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const uuidSchema = z.string().uuid();
export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Código de idioma no válido');
export const timezoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Zona horaria no válida');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, 'Solo minúsculas, números y guiones');

export const clientStatusSchema = z.enum(['onboarding', 'active', 'paused', 'archived']);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url('URL no válida')
  .refine((u) => /^https?:\/\//i.test(u), 'Debe empezar por http:// o https://');

export const createOrganizationSchema = z.object({
  name: trimmed(160).min(2),
  slug: slugSchema,
  ownerEmail: z.string().trim().toLowerCase().email(),
  defaultLocale: localeSchema.default('es'),
  defaultTimezone: timezoneSchema.default('Europe/Madrid'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({
    name: trimmed(160).min(2),
    defaultLocale: localeSchema,
    defaultTimezone: timezoneSchema,
    publishingPaused: z.boolean(),
    requireAdminMfa: z.boolean(),
  })
  .partial()
  .strict();

export const clientInputSchema = z
  .object({
    name: trimmed(160).min(1, 'El nombre es obligatorio'),
    legalName: optionalText(200),
    sector: optionalText(120),
    description: optionalText(4000),
    website: z
      .union([httpUrl, z.literal('').transform(() => null)])
      .nullable()
      .optional(),
    phone: optionalText(40),
    primaryLanguage: localeSchema.default('es'),
    timezone: timezoneSchema.default('Europe/Madrid'),
    accountManagerId: uuidSchema.nullable().optional(),
    status: clientStatusSchema.default('onboarding'),
    onboardedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    businessContext: optionalText(8000),
    aiEnabled: z.boolean().default(true),
  })
  .strict();
export type ClientInput = z.infer<typeof clientInputSchema>;
export const clientUpdateSchema = clientInputSchema.partial().strict();

export const locationInputSchema = z
  .object({
    name: trimmed(160).min(1),
    addressLine: optionalText(300),
    city: optionalText(120),
    region: optionalText(120),
    postalCode: optionalText(20),
    countryCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    phone: optionalText(40),
    timezone: timezoneSchema.nullable().optional(),
    isPrimary: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .strict();
export type LocationInput = z.infer<typeof locationInputSchema>;
export const locationUpdateSchema = locationInputSchema.partial().strict();

export const inviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    roleKey: z.string().min(2).max(63),
    allClientsAccess: z.boolean().default(false),
    clientIds: z.array(uuidSchema).max(500).default([]),
  })
  .strict();

export const updateMemberSchema = z
  .object({
    roleId: uuidSchema,
    allClientsAccess: z.boolean(),
    status: z.enum(['active', 'suspended']),
  })
  .partial()
  .strict();

export const assignClientMemberSchema = z
  .object({ userId: uuidSchema, extraRoleKey: z.string().max(63).nullable().optional() })
  .strict();

export const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: clientStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['name', 'created_at', 'status']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
