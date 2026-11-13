import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-context';

export function LoginPage() {
  const { session, needsMfa } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (session && needsMfa) return <Navigate to="/mfa" replace />;
  if (session)
    return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    setLoading(false);
    // Mensaje genérico: no revelar si el email existe.
    if (error)
      setError(
        error.status === 429
          ? 'Demasiados intentos. Espera unos minutos.'
          : 'Email o contraseña incorrectos.',
      );
  };

  return (
    <AuthLayout title="Inicia sesión" subtitle="Gestiona la reputación digital de tus clientes.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
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
        <Field label="Contraseña" required>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" loading={loading} className="mt-2 w-full">
          Entrar
        </Button>
        <Link
          to="/recuperar"
          className="text-center text-sm text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          ¿Has olvidado tu contraseña?
        </Link>
      </form>
    </AuthLayout>
  );
}
