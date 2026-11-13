import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/features/auth/auth-context';
import { Badge, Card, PageHeader } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Sheet } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}

/** Administración de plataforma (solo superadministradores). */
export function AdminPage() {
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const orgs = useQuery({
    queryKey: ['orgs'],
    queryFn: () => api<OrgRow[]>('/organizations'),
    enabled: !!me.data?.isPlatformAdmin,
  });
  if (me.data && !me.data.isPlatformAdmin) return <Navigate to="/" replace />;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader
        title="Administración de plataforma"
        description="Organizaciones que usan la plataforma."
        actions={
          <>
            <Link to="/cuenta" className="text-sm text-muted hover:text-fg">
              Mi cuenta
            </Link>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Nueva organización
            </Button>
          </>
        }
      />
      <Card>
        <ul className="divide-y divide-border">
          {orgs.data?.map((o) => (
            <li key={o.id} className="flex items-center justify-between px-5 py-3">
              <Link to={`/o/${o.id}`} className="font-medium hover:underline">
                {o.name}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted">
                {o.slug}
                <Badge tone={o.status === 'active' ? 'success' : 'warning'}>{o.status}</Badge>
              </span>
            </li>
          ))}
          {orgs.data?.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-muted">Sin organizaciones.</li>
          )}
        </ul>
      </Card>
      {creating && <CreateOrgSheet open onOpenChange={setCreating} />}
    </main>
  );
}

function CreateOrgSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerEmail, setOwner] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api('/organizations', { method: 'POST', body: { name, slug, ownerEmail } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orgs'] });
      toast('success', 'Organización creada');
      onOpenChange(false);
    },
    onError: (e) =>
      toast(
        'error',
        e instanceof ApiError && e.code === 'MFA_REQUIRED'
          ? 'Activa la verificación en dos pasos para crear organizaciones.'
          : e.message,
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const autoSlug = (v: string) =>
    v
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Nueva organización"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="org-form" loading={create.isPending}>
            Crear
          </Button>
        </>
      }
    >
      <form id="org-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Nombre" required>
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(autoSlug(e.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Identificador (slug)" required hint="Minúsculas, números y guiones.">
          {(p) => <Input {...p} value={slug} onChange={(e) => setSlug(e.target.value)} />}
        </Field>
        <Field
          label="Email del administrador"
          required
          hint="Si no tiene cuenta, recibirá una invitación."
        >
          {(p) => (
            <Input
              {...p}
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwner(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
