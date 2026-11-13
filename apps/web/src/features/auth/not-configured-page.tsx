import { AuthLayout } from './auth-layout';

export function NotConfiguredPage() {
  return (
    <AuthLayout
      title="Configuración pendiente"
      subtitle="La aplicación no tiene configurado el proveedor de autenticación."
    >
      <div className="rounded-lg border border-border bg-surface p-4 text-sm leading-relaxed">
        Define <code className="rounded bg-surface-2 px-1">VITE_SUPABASE_URL</code> y{' '}
        <code className="rounded bg-surface-2 px-1">VITE_SUPABASE_ANON_KEY</code> en{' '}
        <code className="rounded bg-surface-2 px-1">apps/web/.env</code> (ver{' '}
        <code>docs/DEPLOYMENT.md</code>).
      </div>
    </AuthLayout>
  );
}
