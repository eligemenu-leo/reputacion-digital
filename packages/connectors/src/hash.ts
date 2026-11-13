import { createHash } from 'node:crypto';

/** Normaliza texto para deduplicación: NFC, espacios colapsados, recortado. */
export function normalizeText(input: string | null | undefined): string {
  return (input ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function contentHash(...parts: Array<string | number | null | undefined>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(normalizeText(p == null ? '' : String(p))).update('\u0000');
  return h.digest('hex');
}

/** Clave de deduplicación: proveedor + cuenta conectada + id externo. */
export function dedupeKey(
  provider: string,
  connectedAccountId: string,
  externalId: string,
): string {
  return `${provider}:${connectedAccountId}:${externalId}`;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$)/i;

/** URL canónica para menciones web: sin tracking, sin fragmento, host en minúsculas. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol');
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  keep.sort(([a], [b]) => a.localeCompare(b));
  u.search = keep.length ? '?' + new URLSearchParams(keep).toString() : '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))
    u.port = '';
  return u.toString();
}
