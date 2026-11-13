import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field, Input } from './field';

describe('Field (accesibilidad)', () => {
  it('asocia etiqueta, ayuda y error al control', () => {
    render(
      <Field label="Email" hint="Tu email de trabajo" error="Obligatorio" required>
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeRequired();
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Obligatorio');
  });
});
