/**
 * Precios por millón de tokens (USD). Fuente: páginas de modelo de OpenAI
 * (developers.openai.com/api/docs/models/…), consultadas el 2026-11-14.
 * Se pueden sustituir sin desplegar código con la variable AI_PRICES (JSON).
 * Un modelo sin precio conocido NO se usa: no se puede controlar su coste.
 */
export interface ModelPrice {
  input: number;
  output: number;
}
export type PriceTable = Record<string, ModelPrice>;

export const DEFAULT_PRICES: PriceTable = {
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4': { input: 2.5, output: 15 },
  // Proveedor simulado (dev/test): coste ficticio para poder probar el presupuesto.
  'fake-classify': { input: 1, output: 1 },
  'fake-draft': { input: 1, output: 1 },
  'fake-summary': { input: 1, output: 1 },
};

export function priceFor(table: PriceTable, model: string): ModelPrice | null {
  return table[model] ?? null;
}

export function costUsd(p: ModelPrice, inputTokens: number, outputTokens: number): number {
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1e6) * 1e6) / 1e6;
}

/** Estimación prudente antes de llamar: ~3 caracteres por token y salida máxima. */
export function estimateCost(p: ModelPrice, promptChars: number, maxOutputTokens: number): number {
  return costUsd(p, Math.ceil(promptChars / 3) + 50, maxOutputTokens);
}
