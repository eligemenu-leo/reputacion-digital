import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { AuthLayout } from './auth-layout';

export function RecoverPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await supabase!.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/nueva-contrasena`,
    });
    setLoading(false);
    // Siempre el mismo mensaje para no revelar qué emails existen.
    setSent(true);
  };

  return (
    <AuthLayout
      title="Recuperar acceso"
      subtitle="Te enviaremos un enlace para crear una nueva contraseña."
    >
      {sent ? (
        <div role="status" className="rounded-lg border border-border bg-surface p-4 text-sm">
          Si existe una cuenta con ese email, recibirás un enlace en unos minutos.
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Email" required>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={loading} className="w-full">
            Enviar enlace
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-6 block text-center text-sm text-muted hover:text-fg">
        Volver a iniciar sesión
      </Link>
    </AuthLayout>
  );
}
