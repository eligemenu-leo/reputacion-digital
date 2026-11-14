/**
 * Proveedor de IA SIMULADO para desarrollo y pruebas. No envía datos fuera ni
 * usa modelos reales: aplica reglas simples y deterministas. Sus resultados se
 * marcan en la interfaz como «IA simulada». Prohibido en staging/producción
 * (lo impone config.ts).
 */
import type { AiProvider, AiRequest, AiResponse } from './provider';

type Handler = (req: AiRequest) => unknown | Promise<unknown>;

const has = (s: string, re: RegExp) => re.test(s);

function interactionText(user: string) {
  const m = /<interaction>\n([\s\S]*?)\n<\/interaction>/.exec(user);
  return m?.[1] ?? '';
}

export function fakeClassify(req: AiRequest) {
  const text = interactionText(req.user).toLowerCase();
  const rating = Number(/valoración: (\d+(?:\.\d+)?)\//.exec(req.user)?.[1] ?? NaN);
  const signals: string[] = [];
  if (has(text, /intoxica|higiene|comida en mal estado/)) signals.push('food_safety');
  if (has(text, /hospital|urgencias|alergi|malestar/)) signals.push('health');
  if (has(text, /abogad|denuncia|demanda/)) signals.push('legal_threat');
  if (has(text, /racis|discrimin/)) signals.push('discrimination');
  if (has(text, /ignora|ignore|instrucciones|system prompt|publica/))
    signals.push('prompt_injection_attempt');
  const negative = rating <= 2 || has(text, /mal|horrible|nunca más|lento|frí[oa]/);
  const positive = rating >= 4 && !negative;
  const sentiment = positive ? 'positive' : negative ? 'negative' : 'neutral';
  const critical = signals.some((s) => s !== 'prompt_injection_attempt');
  return {
    language: 'es',
    sentiment,
    confidence: 0.6,
    category: critical
      ? 'sensitive_claim'
      : positive
        ? 'praise'
        : negative
          ? 'complaint'
          : 'neutral',
    topics: [
      has(text, /servicio|camarer|atenci/) && 'servicio',
      has(text, /precio|caro/) && 'precio',
      has(text, /comida|plato|cena/) && 'comida',
    ].filter(Boolean),
    priority: critical ? 'critical' : negative ? 'high' : positive ? 'low' : 'normal',
    requires_response: true,
    risk_signals: signals,
    rationale: 'Clasificación de la IA simulada (reglas de prueba, no un modelo real).',
  };
}

export function fakeDraft(req: AiRequest) {
  const text = interactionText(req.user).toLowerCase();
  const name = /nombre: (.+)/.exec(req.user)?.[1] ?? 'el equipo';
  const shorter = req.user.includes('más breve');
  const negative = /sentimiento: (negative|mixed)/.test(req.user);
  const reply = negative
    ? `Lamentamos mucho lo ocurrido y gracias por contárnoslo. Revisaremos lo que nos indica para mejorar.${shorter ? '' : ` Un saludo del equipo de ${name}.`}`
    : `¡Muchas gracias por su reseña! Nos alegra que haya disfrutado de la visita.${shorter ? '' : ` Esperamos verle pronto. El equipo de ${name}.`}`;
  return {
    reply,
    tone_applied: 'cordial (IA simulada)',
    used_facts: [],
    warnings: /intoxica|abogad|denuncia/.test(text)
      ? ['La reseña menciona un asunto delicado: requiere revisión especializada.']
      : [],
  };
}

/** Resumen simulado: solo usa cifras presentes en <metrics> y los 3 primeros ejemplos del tema principal. */
export function fakeSummary(req: AiRequest) {
  const m = JSON.parse(/<metrics>\n([\s\S]*?)\n<\/metrics>/.exec(req.user)?.[1] ?? '{}') as {
    total?: number;
    negative_pct?: number;
    topics?: { topic: string }[];
  };
  const topic = m.topics?.[0]?.topic ?? '';
  const refs = [...req.user.matchAll(/\[(r\d+)\] temas: ([^·]*)·/g)]
    .filter((x) =>
      x[2]!
        .split(',')
        .map((s) => s.trim())
        .includes(topic),
    )
    .map((x) => x[1]!)
    .slice(0, 3);
  return {
    headline: `Resumen simulado de ${m.total ?? 0} interacciones`,
    summary: `En el periodo hubo ${m.total ?? 0} interacciones; el ${m.negative_pct ?? 0} % fueron negativas o mixtas. Texto de la IA simulada (reglas de prueba).`,
    findings:
      topic && refs.length >= 3
        ? [
            {
              kind: 'watch',
              topic,
              title: `Tema frecuente: ${topic}`,
              description: 'Aparece de forma recurrente en las reseñas.',
              supporting_refs: refs,
            },
          ]
        : [],
    caveats: ['Resumen generado por la IA simulada, no por un modelo real.'],
  };
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake' as const;
  calls: AiRequest[] = [];
  /** Permite a las pruebas forzar salidas o errores concretos. */
  constructor(private handlers: Partial<Record<AiRequest['task'], Handler>> = {}) {}

  setHandler(task: AiRequest['task'], h: Handler | undefined) {
    this.handlers[task] = h;
  }

  async generate(req: AiRequest): Promise<AiResponse> {
    this.calls.push(req);
    const h =
      this.handlers[req.task] ??
      { classification: fakeClassify, draft: fakeDraft, summary: fakeSummary }[req.task];
    const output = await h(req);
    return {
      output,
      model: req.model,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: Math.ceil(JSON.stringify(output).length / 4),
      latencyMs: 1,
    };
  }
}
