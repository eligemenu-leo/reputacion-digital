/**
 * Utilidades de texto para la IA: neutralizar contenido externo no confiable,
 * minimizar datos personales y validar borradores.
 */

// Caracteres invisibles o de control de dirección usados para ocultar instrucciones.
const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
export const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+\.(?:com|es|net|org|info|io|eu|cat|biz|me)(?:\/[^\s]*)?\b/giu;
// Secuencias de 9+ dígitos con separadores típicos (teléfonos).
export const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\d[\s.-]?){8,13}\d/g;

/**
 * Prepara texto externo para incluirlo dentro de delimitadores: elimina
 * caracteres invisibles y de control, normaliza Unicode y sustituye `<` y `>`
 * para que el contenido no pueda cerrar el bloque `<interaction>`.
 */
export function neutralize(text: string, maxChars = 4000): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .slice(0, maxChars);
}

/** Enmascara emails y teléfonos (minimización antes de enviar al proveedor). */
export function maskPersonalData(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[teléfono]');
}

/** ¿Contenía el texto original caracteres invisibles? (señal de posible manipulación). */
export function hasInvisibleChars(text: string): boolean {
  return new RegExp(INVISIBLE.source, 'u').test(text);
}

function trigrams(s: string): Set<string> {
  const n = ` ${s.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < n.length - 2; i++) out.add(n.slice(i, i + 3));
  return out;
}

/** Similitud de Jaccard sobre trigramas de caracteres (0…1). */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const digits = (s: string) => s.replace(/\D/g, '');

export interface DraftCheckInput {
  reply: string;
  /** Texto con la información verificada del negocio (lo único citable). */
  verifiedText: string;
  forbiddenExpressions: string[];
  maxChars: number;
  recentReplies: string[];
  similarityThreshold?: number;
}

/**
 * Validaciones deterministas del borrador. Devuelve los motivos de rechazo
 * (vacío = aceptado). Ninguna depende de que el modelo «se porte bien».
 */
export function checkDraft(i: DraftCheckInput): string[] {
  const reasons: string[] = [];
  const reply = i.reply.trim();
  if (!reply) reasons.push('El borrador está vacío');
  if (reply.length > i.maxChars) {
    reasons.push(
      `El borrador supera la longitud permitida (${reply.length} de ${i.maxChars} caracteres)`,
    );
  }
  const verified = i.verifiedText.toLowerCase();
  for (const m of reply.match(URL_RE) ?? []) {
    if (!verified.includes(m.toLowerCase().replace(/[.,;:)]+$/, ''))) {
      reasons.push(`Contiene un enlace no verificado: ${m}`);
    }
  }
  for (const m of reply.match(EMAIL_RE) ?? []) {
    if (!verified.includes(m.toLowerCase())) reasons.push(`Contiene un email no verificado: ${m}`);
  }
  const verifiedDigits = digits(i.verifiedText);
  for (const m of reply.match(PHONE_RE) ?? []) {
    if (!verifiedDigits.includes(digits(m)))
      reasons.push(`Contiene un teléfono no verificado: ${m.trim()}`);
  }
  const lower = reply.toLowerCase();
  for (const f of i.forbiddenExpressions) {
    if (f.trim() && lower.includes(f.trim().toLowerCase())) {
      reasons.push(`Usa una expresión prohibida por la marca: «${f.trim()}»`);
    }
  }
  const threshold = i.similarityThreshold ?? 0.8;
  if (i.recentReplies.some((r) => similarity(r, reply) >= threshold)) {
    reasons.push('Es casi idéntico a una respuesta publicada recientemente');
  }
  return reasons;
}

export const LENGTH_LIMITS = { short: 350, medium: 700, long: 1200 } as const;
