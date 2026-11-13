import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-context';

/** Verificación TOTP cuando el usuario tiene MFA configurado (aal1 → aal2). */
export function MfaPage() {
  const { session, needsMfa, refreshAal, signOut } = useAuth();
  const nav = useNavigate();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase?.auth.mfa
      .listFactors()
      .then(({ data }) => setFactorId(data?.totp.find((f) => f.status === 'verified')?.id ?? null));
  }, []);

  if (!session) return <Navigate to="/login" replace />;
  if (!needsMfa) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!factorId) return;
    setLoading(true);
    setError(null);
    const { error } = await supabase!.auth.mfa.challengeAndVerify({
      factorId,
      code: code.replace(/\s/g, ''),
    });
    setLoading(false);
    if (error) return setError('Código incorrecto o caducado.');
    await refreshAal();
    nav('/', { replace: true });
  };

  return (
    <AuthLayout
      title="Verificación en dos pasos"
      subtitle="Introduce el código de 6 dígitos de tu aplicación de autenticación."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Código" required error={error ?? undefined}>
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="tracking-[0.3em] text-center text-lg"
            />
          )}
        </Field>
        <Button
          type="submit"
          loading={loading}
          disabled={!factorId || code.length < 6}
          className="w-full"
        >
          Verificar
        </Button>
        <button type="button" onClick={signOut} className="text-sm text-muted hover:text-fg">
          Cerrar sesión
        </button>
      </form>
    </AuthLayout>
  );
}
