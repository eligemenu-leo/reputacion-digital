/** Errores de dominio con código estable; la API los traduce a HTTP. */
export const ERROR_CODES = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  RATE_LIMITED: 429,
  NOT_SUPPORTED: 501,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_CODES[this.code];
  }
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}
