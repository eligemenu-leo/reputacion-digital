import { describe, expect, it } from 'vitest';
import { contentHash, dedupeKey, normalizeUrl } from './hash';

describe('deduplicación', () => {
  it('el hash ignora diferencias de espacios y normalización unicode', () => {
    expect(contentHash('Muy  bueno\n', 5)).toBe(contentHash('Muy bueno', 5));
    expect(contentHash('café')).toBe(contentHash('café'));
    expect(contentHash('bueno', 5)).not.toBe(contentHash('bueno', 4));
  });

  it('la clave incluye proveedor y cuenta conectada', () => {
    expect(dedupeKey('gbp', 'acc1', 'r1')).not.toBe(dedupeKey('gbp', 'acc2', 'r1'));
  });

  it('normaliza URLs eliminando tracking y fragmentos', () => {
    expect(normalizeUrl('https://WWW.Ejemplo.es/noticia/?utm_source=x&b=2&a=1#top')).toBe(
      'https://ejemplo.es/noticia?a=1&b=2',
    );
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow();
  });
});
