import { describe, expect, it } from 'vitest';
import { clientInputSchema, createOrganizationSchema, locationInputSchema } from './schemas';

describe('validación de entradas', () => {
  it('normaliza campos opcionales vacíos a null', () => {
    const r = clientInputSchema.parse({ name: ' Bar Pepe ', legalName: '', website: '' });
    expect(r.name).toBe('Bar Pepe');
    expect(r.legalName).toBeNull();
    expect(r.website).toBeNull();
    expect(r.primaryLanguage).toBe('es');
  });

  it('rechaza URLs con esquemas peligrosos', () => {
    expect(clientInputSchema.safeParse({ name: 'x', website: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(clientInputSchema.safeParse({ name: 'x', website: 'ftp://x.com' }).success).toBe(false);
    expect(clientInputSchema.safeParse({ name: 'x', website: 'https://x.com' }).success).toBe(true);
  });

  it('rechaza campos desconocidos (p.ej. organization_id inyectado)', () => {
    expect(clientInputSchema.safeParse({ name: 'x', organizationId: 'abc' }).success).toBe(false);
  });

  it('valida zonas horarias IANA', () => {
    expect(clientInputSchema.safeParse({ name: 'x', timezone: 'Mars/Olympus' }).success).toBe(
      false,
    );
    expect(clientInputSchema.safeParse({ name: 'x', timezone: 'Atlantic/Canary' }).success).toBe(
      true,
    );
  });

  it('valida slug de organización', () => {
    expect(
      createOrganizationSchema.safeParse({
        name: 'Agencia',
        slug: 'Mi Agencia',
        ownerEmail: 'a@b.es',
      }).success,
    ).toBe(false);
    expect(
      createOrganizationSchema.parse({ name: 'Agencia', slug: 'mi-agencia', ownerEmail: 'A@B.es' })
        .ownerEmail,
    ).toBe('a@b.es');
  });

  it('normaliza códigos de país', () => {
    expect(locationInputSchema.parse({ name: 'Centro', countryCode: 'es' }).countryCode).toBe('ES');
  });
});
