/**
 * Adaptador de proveedor de IA (ADR-019). Los servicios solo conocen esta
 * interfaz: salida estructurada (JSON Schema estricto), sin herramientas y sin
 * almacenamiento en el proveedor (`store: false`).
 */
export interface AiRequest {
  model: string;
  /** Instrucciones de sistema (confiables). */
  system: string;
  /** Mensaje de usuario: contiene el contenido externo delimitado y escapado. */
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  /** Etiqueta para el proveedor simulado; el real la ignora. */
  task: 'classification' | 'draft';
}

export interface AiResponse {
  /** JSON ya parseado; los servicios lo validan con Zod. */
  output: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type AiErrorKind =
  | 'auth' // clave inválida o revocada: no se reintenta
  | 'rate_limited'
  | 'transient' // 5xx, red, timeout
  | 'refusal' // el modelo se negó
  | 'incomplete' // salida truncada
  | 'invalid_output' // no es JSON válido
  | 'bad_request';

export class AiProviderError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
  }
  get retryable() {
    return this.kind === 'rate_limited' || this.kind === 'transient';
  }
}

export interface AiProvider {
  readonly name: 'openai' | 'fake';
  generate(req: AiRequest): Promise<AiResponse>;
}

interface OpenAiResponseBody {
  status?: string;
  model?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string; refusal?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Cliente mínimo de la Responses API de OpenAI (sin SDK: una sola llamada). */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  constructor(
    private opts: {
      apiKey: string;
      baseUrl?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async generate(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl ?? 'https://api.openai.com/v1'}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          instructions: req.system,
          input: [{ role: 'user', content: req.user }],
          text: {
            format: {
              type: 'json_schema',
              name: req.schemaName,
              schema: req.jsonSchema,
              strict: true,
            },
          },
          max_output_tokens: req.maxOutputTokens,
          store: false,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new AiProviderError(
        'transient',
        `No se pudo contactar con OpenAI: ${(err as Error).name}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as OpenAiResponseBody;
    if (!res.ok) {
      // Nunca se incluye la clave; el mensaje del proveedor se recorta.
      const msg = (body.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new AiProviderError('auth', msg);
      if (res.status === 429) throw new AiProviderError('rate_limited', msg);
      if (res.status >= 500) throw new AiProviderError('transient', msg);
      throw new AiProviderError('bad_request', msg);
    }
    const usage = {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
    if (body.status === 'incomplete') {
      throw new AiProviderError(
        'incomplete',
        `Respuesta incompleta (${body.incomplete_details?.reason ?? 'desconocido'})`,
        usage,
      );
    }
    const parts = (body.output ?? []).flatMap((o) =>
      o.type === 'message' ? (o.content ?? []) : [],
    );
    const refusal = parts.find((p) => p.type === 'refusal');
    if (refusal)
      throw new AiProviderError('refusal', (refusal.refusal ?? 'Rechazado').slice(0, 300), usage);
    const text = parts
      .filter((p) => p.type === 'output_text')
      .map((p) => p.text ?? '')
      .join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new AiProviderError('invalid_output', 'La salida del modelo no es JSON válido', usage);
    }
    return { output, model: body.model ?? req.model, ...usage, latencyMs: Date.now() - started };
  }
}
