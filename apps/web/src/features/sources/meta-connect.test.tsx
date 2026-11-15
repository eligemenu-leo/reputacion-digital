import { describe, expect, it } from 'vitest';
import { matches, normalize } from './meta-connect';

describe('Buscador de páginas y clientes', () => {
  it('ignora mayúsculas y tildes', () => {
    expect(normalize('  Sidrería El Llugarín ')).toBe('sidreria el llugarin');
    expect(matches('Sidrería El Llugarín', 'llugarin')).toBe(true);
    expect(matches('@elllugarinsidreria', 'LLUGAR')).toBe(true);
    expect(matches('eligemenu', 'gorda')).toBe(false);
    expect(matches('eligemenu', '')).toBe(true);
  });
});
