import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from '@rep/shared';
import type { Config } from '../config';

export interface AuthContext {
  userId: string;
  email: string | null;
  /** Nivel de autenticación de Supabase: aal1 (contraseña) o aal2 (MFA). */
  aal: 'aal1' | 'aal2';
  sessionId: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthContext>;

export function createTokenVerifier(
  config: Pick<Config, 'SUPABASE_URL' | 'SUPABASE_JWT_SECRET' | 'SUPABASE_JWT_ISSUER'>,
): TokenVerifier {
  const issuer =
    config.SUPABASE_JWT_ISSUER ??
    (config.SUPABASE_URL ? `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1` : undefined);
  const secret = config.SUPABASE_JWT_SECRET
    ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
    : null;
  const jwks: JWTVerifyGetKey | null = config.SUPABASE_URL
    ? createRemoteJWKSet(
        new URL(`${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`),
      )
    : null;

  return async (token: string) => {
    let payload: JWTPayload;
    try {
      const header = JSON.parse(
        Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
      ) as { alg?: string };
      const opts = { audience: 'authenticated', ...(issuer ? { issuer } : {}) };
      if (header.alg === 'HS256') {
        if (!secret) throw new Error('HS256 not enabled');
        ({ payload } = await jwtVerify(token, secret, { ...opts, algorithms: ['HS256'] }));
      } else {
        if (!jwks) throw new Error('JWKS not configured');
        ({ payload } = await jwtVerify(token, jwks, { ...opts, algorithms: ['ES256', 'RS256'] }));
      }
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Sesión no válida o caducada');
    }
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'Token sin usuario autenticado');
    }
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    };
  };
}
