import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/ui/misc';
import { SecuritySettings } from './settings-page';

/** Seguridad de la cuenta accesible sin organización (p. ej. superadministradores). */
export function AccountPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ChevronLeft className="size-4" aria-hidden />
        Inicio
      </Link>
      <PageHeader title="Mi cuenta" />
      <SecuritySettings />
    </main>
  );
}
