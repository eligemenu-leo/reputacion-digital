/**
 * Sellado de secretos (tokens OAuth, verificadores PKCE) con AES-256-GCM (ADR-024).
 *
 * Formato: `v1.<kid>.<iv>.<tag>.<datos>` (base64url). El AAD liga el texto
 * cifrado a su fila (p. ej. el id de la credencial): copiar el valor a otra
 * fila no permite descifrarlo. La clave vive solo en el entorno de la API y
 * del worker; un volcado de la base de datos no basta para leer los tokens.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '@rep/shared';

export interface SecretBox {
  readonly keyId: string;
  seal(plain: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

/** `keys`: "kid:base64(32 bytes)[,kid2:...]". La primera clave cifra; todas descifran (rotación). */
export function createSecretBox(keys: string): SecretBox {
  const parsed = keys
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(':');
      const kid = entry.slice(0, i);
      const key = Buffer.from(entry.slice(i + 1), 'base64');
      if (i < 1 || !/^[\w-]{1,20}$/.test(kid) || key.length !== 32) {
        throw new Error('CREDENTIALS_ENCRYPTION_KEYS: formato «kid:clave-base64-de-32-bytes»');
      }
      return [kid, key] as const;
    });
  if (!parsed.length) throw new Error('CREDENTIALS_ENCRYPTION_KEYS vacío');
  const byId = new Map(parsed);
  const [currentId, current] = parsed[0]!;
  return {
    keyId: currentId,
    seal(plain, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', current, iv);
      c.setAAD(Buffer.from(aad));
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', currentId, iv, c.getAuthTag(), data]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },
    open(sealed, aad) {
      const [v, kid, iv, tag, data] = sealed.split('.');
      const key = kid ? byId.get(kid) : undefined;
      if (v !== 'v1' || !key || !iv || !tag || data === undefined) {
        throw new AppError('INTERNAL', 'Credencial sellada con una clave no disponible');
      }
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString(
          'utf8',
        );
      } catch {
        throw new AppError('INTERNAL', 'No se pudo descifrar la credencial');
      }
    },
  };
}
