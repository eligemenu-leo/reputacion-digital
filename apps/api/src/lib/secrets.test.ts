import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { createSecretBox } from './secrets';

const key = (n: number) => Buffer.alloc(32, n).toString('base64');

describe('sellado de credenciales', () => {
  it('cifra con la clave actual, liga el texto a su fila y detecta manipulaciones', () => {
    const box = createSecretBox(`k2:${key(2)},k1:${key(1)}`);
    const s = box.seal('{"accessToken":"ya29.secreto"}', 'fila-1');
    expect(s.startsWith('v1.k2.')).toBe(true);
    expect(s).not.toContain('secreto');
    expect(box.open(s, 'fila-1')).toContain('ya29.secreto');
    expect(() => box.open(s, 'fila-2')).toThrow();
    const parts = s.split('.');
    parts[4] = Buffer.from('otra cosa').toString('base64url');
    expect(() => box.open(parts.join('.'), 'fila-1')).toThrow();
  });

  it('descifra lo sellado con una clave anterior (rotación) y rechaza claves desconocidas', () => {
    const old = createSecretBox(`k1:${key(1)}`).seal('dato', 'x');
    expect(createSecretBox(`k2:${key(2)},k1:${key(1)}`).open(old, 'x')).toBe('dato');
    expect(() => createSecretBox(`k2:${key(2)}`).open(old, 'x')).toThrow();
  });

  it('exige claves de 32 bytes con identificador', () => {
    expect(() => createSecretBox('sin-separador')).toThrow();
    expect(() => createSecretBox(`k1:${Buffer.alloc(16).toString('base64')}`)).toThrow();
  });
});

describe('configuración', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x@localhost/db',
    SUPABASE_JWT_SECRET: 's'.repeat(32),
  };
  it('trata las variables vacías de .env.example como no definidas', () => {
    const c = loadConfig({
      ...base,
      OPENAI_API_KEY: '',
      GOOGLE_OAUTH_CLIENT_ID: '',
      CREDENTIALS_ENCRYPTION_KEYS: '',
    } as NodeJS.ProcessEnv);
    expect(c.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(c.CREDENTIALS_ENCRYPTION_KEYS).toBeUndefined();
  });
  it('en producción la URL pública de la API debe ser https', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        AUTHOR_REF_PEPPER: 'p'.repeat(20),
        API_PUBLIC_URL: 'http://api.example.com',
      } as NodeJS.ProcessEnv),
    ).toThrow(/https/);
  });
});
