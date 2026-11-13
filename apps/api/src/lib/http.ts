import { AppError } from '@rep/shared';
import type { z } from 'zod';

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError(
      'VALIDATION',
      'Datos no válidos',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** Traduce errores de PostgreSQL a errores de dominio sin filtrar detalles internos. */
export function mapDbError(err: unknown): AppError | null {
  const e = err as { code?: string; constraint_name?: string };
  switch (e?.code) {
    case '42501':
      return new AppError('FORBIDDEN', 'Operación no permitida');
    case '23505':
      return new AppError('CONFLICT', 'Ya existe un registro con esos datos', {
        constraint: e.constraint_name,
      });
    case '23503':
      return new AppError('VALIDATION', 'Referencia no válida', { constraint: e.constraint_name });
    case '23514':
    case '22P02':
    case '22007':
      return new AppError('VALIDATION', 'Valor no válido', { constraint: e.constraint_name });
    default:
      return null;
  }
}
