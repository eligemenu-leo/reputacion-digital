import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-context';

/** Sirve tanto para recuperación como para aceptar una invitación (fijar contraseña). */
export function ResetPasswordPage() {
  const { session, loading: authLoading } = useAuth();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Los enlaces de invitación de Supabase Auth llegan con tokens en el fragmento (#access_token=…).
  // Se consumen una vez, se establece la sesión y se limpia la URL para no dejar tokens en el historial.
  const [processingLink, setProcessingLink] = useState(() =>
    window.location.hash.includes('access_token='),
  );
  useEffect(() => {
    if (!processingLink || !supabase) return;
    const h = new URLSearchParams(window.location.hash.slice(1));
    const access_token = h.get('access_token');
    const refresh_token = h.get('refresh_token');
    window.history.replaceState(null, '', window.location.pathname);
    if (!access_token || !refresh_token) return setProcessingLink(false);
    void supabase.auth
      .setSession({ access_token, refresh_token })
      .finally(() => setProcessingLink(false));
  }, [processingLink]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) return setError('Usa al menos 12 caracteres.');
    if (password !== confirm) return setError('Las contraseñas no coinciden.');
    setLoading(true);
    const { error } = await supabase!.auth.updateUser({ password });
    setLoading(false);
    if (error) return setError('No se pudo actualizar la contraseña. Solicita un nuevo enlace.');
    nav('/', { replace: true });
  };

  if (authLoading || processingLink) return null;
  if (!session) {
    return (
      <AuthLayout
        title="Enlace no válido"
        subtitle="El enlace ha caducado o ya se ha utilizado. Solicita uno nuevo desde la pantalla de acceso."
      >
        <Button onClick={() => nav('/recuperar')}>Solicitar nuevo enlace</Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Nueva contraseña"
      subtitle="Mínimo 12 caracteres. Te recomendamos usar un gestor de contraseñas."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Contraseña" required>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Repite la contraseña" required error={error ?? undefined}>
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" loading={loading} className="w-full">
          Guardar y entrar
        </Button>
      </form>
    </AuthLayout>
  );
}
