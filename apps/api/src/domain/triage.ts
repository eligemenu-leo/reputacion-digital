/**
 * Triaje determinista PRELIMINAR (Fase 2). No es IA: reglas simples y
 * explicables para ordenar la bandeja hasta que llegue el análisis de la
 * Fase 3. Ante la duda, sube la prioridad y pide revisión humana especializada.
 */
export interface Triage {
  priority: 1 | 2 | 3 | 4;
  riskFlags: string[];
  requiresSpecialist: boolean;
}

const RULES: Array<{ flag: string; re: RegExp; specialist: boolean }> = [
  {
    flag: 'legal',
    re: /\b(abogad[oa]s?|denuncia\w*|demanda\w*|reclamaci[oó]n formal|tribunal\w*|juzgado)\b/i,
    specialist: true,
  },
  {
    flag: 'health',
    re: /\b(intoxicaci[oó]n|malestar|hospital\w*|urgencias|alergia|al[eé]rgic\w*|enferm\w*)\b/i,
    specialist: true,
  },
  { flag: 'safety', re: /\b(agresi[oó]n|amenaz\w*|acoso|robo|incendio)\b/i, specialist: true },
  {
    flag: 'discrimination',
    re: /\b(racis\w*|discrimin\w*|machis\w*|hom[oó]fob\w*)\b/i,
    specialist: true,
  },
  // Texto que intenta dar instrucciones al sistema: se trata como dato y se marca.
  {
    flag: 'prompt_injection',
    re: /\b(ignora (tus|las) instrucciones|ignore (all |your )?(previous )?instructions|system prompt)\b/i,
    specialist: false,
  },
];

export function triage(
  content: string | null,
  rating: number | null | undefined,
  scale = 5,
): Triage {
  const text = content ?? '';
  const riskFlags = RULES.filter((r) => r.re.test(text)).map((r) => r.flag);
  const requiresSpecialist = RULES.some((r) => r.specialist && riskFlags.includes(r.flag));
  const normalized = rating == null ? null : (rating / scale) * 5;
  let priority: Triage['priority'] = 2;
  if (normalized != null && normalized <= 2) priority = 3;
  if (normalized != null && normalized >= 4 && !text) priority = 1;
  if (requiresSpecialist) priority = 4;
  return { priority, riskFlags, requiresSpecialist };
}
