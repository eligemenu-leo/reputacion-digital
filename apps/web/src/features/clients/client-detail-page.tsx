import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ChevronLeft, ExternalLink, MapPin, Pencil, Plus, Trash2, UserMinus } from 'lucide-react';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { ClientDetail, Location, Member } from '@/lib/types';
import { CLIENT_STATUS, LANGUAGES } from '@/lib/labels';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { ClientFormSheet } from './client-form';
import { LocationFormSheet } from './location-form';

const TABS = [
  { key: 'ficha', label: 'Ficha' },
  { key: 'ubicaciones', label: 'Ubicaciones' },
  { key: 'equipo', label: 'Equipo' },
  { key: 'marca', label: 'Personalidad de marca' },
  { key: 'fuentes', label: 'Fuentes' },
] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm sm:col-span-2">{children || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

export function ClientDetailPage() {
  const { orgId } = useOrg();
  const { clientId } = useParams<{ clientId: string }>();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('ficha');
  const [editing, setEditing] = useState(false);
  const [locSheet, setLocSheet] = useState<{ open: boolean; location?: Location }>({ open: false });
  const [toDelete, setToDelete] = useState<Location | null>(null);
  const [assignUser, setAssignUser] = useState('');
  const qc = useQueryClient();
  const toast = useToast();

  const q = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => api<ClientDetail>(`/clients/${clientId}`),
  });
  const c = q.data;
  const members = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api<Member[]>(`/organizations/${orgId}/members`),
    enabled: tab === 'equipo' && !!c?.permissions.canManageMembers,
  });

  const delLoc = useMutation({
    mutationFn: (id: string) => api(`/clients/${clientId}/locations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
      toast('success', 'Ubicación eliminada');
      setToDelete(null);
    },
    onError: (e) => toast('error', e.message),
  });
  const assign = useMutation({
    mutationFn: (userId: string) =>
      api(`/clients/${clientId}/members`, { method: 'POST', body: { userId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
      setAssignUser('');
      toast('success', 'Usuario asignado');
    },
    onError: (e) => toast('error', e.message),
  });
  const unassign = useMutation({
    mutationFn: (userId: string) =>
      api(`/clients/${clientId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
      toast('success', 'Asignación retirada');
    },
    onError: (e) => toast('error', e.message),
  });

  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  if (q.isError || !c) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const lang = LANGUAGES.find((l) => l.value === c.primaryLanguage)?.label ?? c.primaryLanguage;
  const assignedIds = new Set(c.members.map((m) => m.userId));

  return (
    <>
      <Link
        to={`/o/${orgId}/clientes`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden /> Clientes
      </Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-lg font-semibold text-accent">
            {c.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{c.name}</h1>
              <Badge tone={CLIENT_STATUS[c.status].tone}>{CLIENT_STATUS[c.status].label}</Badge>
              {!c.aiEnabled && <Badge tone="warning">IA desactivada</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {[c.sector, `${c.locations.length} ubicaciones`].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        {c.permissions.canUpdate && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden />
            Editar
          </Button>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Secciones del cliente"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-border"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              tab === t.key
                ? 'border-accent font-medium text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'ficha' && (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="px-5 lg:col-span-2">
              <dl className="divide-y divide-border">
                <Row label="Razón social">{c.legalName}</Row>
                <Row label="Web">
                  {c.website && (
                    <a
                      href={c.website}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      {c.website.replace(/^https?:\/\//, '')}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  )}
                </Row>
                <Row label="Teléfono">{c.phone}</Row>
                <Row label="Idioma principal">{lang}</Row>
                <Row label="Zona horaria">{c.timezone}</Row>
                <Row label="Fecha de incorporación">
                  {new Date(c.onboardedAt).toLocaleDateString('es-ES', { dateStyle: 'long' })}
                </Row>
                <Row label="Descripción">
                  <p className="whitespace-pre-line">{c.description}</p>
                </Row>
              </dl>
            </Card>
            <Card className="p-5">
              <h2 className="text-sm font-semibold">Información verificada del negocio</h2>
              <p className="mt-1 text-xs text-muted">
                Contexto que la IA podrá usar al redactar respuestas.
              </p>
              <p className="mt-3 whitespace-pre-line text-sm">
                {c.businessContext || <span className="text-muted">Sin información todavía.</span>}
              </p>
            </Card>
          </div>
        )}

        {tab === 'ubicaciones' && (
          <Card>
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-semibold">Ubicaciones</h2>
              {c.permissions.canUpdate && (
                <Button size="sm" onClick={() => setLocSheet({ open: true })}>
                  <Plus className="size-4" aria-hidden />
                  Añadir
                </Button>
              )}
            </div>
            {c.locations.length === 0 ? (
              <EmptyState
                icon={<MapPin className="size-5" aria-hidden />}
                title="Sin ubicaciones"
                description="Añade los establecimientos del cliente. Cada uno podrá vincularse a sus perfiles (p. ej. Google Business Profile)."
              />
            ) : (
              <ul className="divide-y divide-border">
                {c.locations.map((l) => (
                  <li key={l.id} className="flex items-center gap-4 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {l.name}
                        {l.isPrimary && <Badge tone="accent">Principal</Badge>}
                        {!l.isActive && <Badge>Inactiva</Badge>}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {[l.addressLine, l.postalCode, l.city, l.region, l.countryCode]
                          .filter(Boolean)
                          .join(', ') || 'Sin dirección'}
                      </p>
                    </div>
                    {c.permissions.canUpdate && (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setLocSheet({ open: true, location: l })}
                          aria-label={`Editar ${l.name}`}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setToDelete(l)}
                          aria-label={`Eliminar ${l.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {tab === 'equipo' && (
          <Card>
            <div className="border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-semibold">Usuarios asignados</h2>
              <p className="mt-0.5 text-xs text-muted">
                Los administradores con acceso a todos los clientes no necesitan asignación.
              </p>
            </div>
            {c.permissions.canManageMembers && (
              <form
                className="flex flex-col gap-2 border-b border-border px-5 py-3.5 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (assignUser) assign.mutate(assignUser);
                }}
              >
                <Select
                  aria-label="Usuario a asignar"
                  value={assignUser}
                  onChange={(e) => setAssignUser(e.target.value)}
                  className="sm:max-w-xs"
                >
                  <option value="">Selecciona un usuario…</option>
                  {members.data
                    ?.filter(
                      (m) =>
                        m.status === 'active' && !m.allClientsAccess && !assignedIds.has(m.userId),
                    )
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.fullName ?? m.email} · {m.roleName}
                      </option>
                    ))}
                </Select>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!assignUser}
                  loading={assign.isPending}
                >
                  Asignar
                </Button>
              </form>
            )}
            {c.members.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted">
                No hay usuarios asignados específicamente a este cliente.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {c.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.fullName ?? m.email}</p>
                      <p className="truncate text-xs text-muted">{m.email}</p>
                    </div>
                    {m.extraRoleName && <Badge tone="accent">{m.extraRoleName}</Badge>}
                    {c.permissions.canManageMembers && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => unassign.mutate(m.userId)}
                        aria-label={`Retirar a ${m.fullName ?? m.email}`}
                      >
                        <UserMinus className="size-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {tab === 'marca' && (
          <Card>
            <EmptyState
              title="Disponible en Fase 3"
              description="Tono, formalidad, tratamiento, expresiones recomendadas y prohibidas, ejemplos aprobados y versionado. El modelo de datos ya está preparado."
            />
          </Card>
        )}
        {tab === 'fuentes' && (
          <Card>
            <EmptyState
              title="Disponible en Fase 4"
              description="Conexión con Google Business Profile, Facebook e Instagram. Requiere aprobaciones externas de Google y Meta."
            />
          </Card>
        )}
      </div>

      {editing && (
        <ClientFormSheet orgId={orgId} client={c} open={editing} onOpenChange={setEditing} />
      )}
      {locSheet.open && (
        <LocationFormSheet
          clientId={c.id}
          location={locSheet.location}
          open
          onOpenChange={(o) => setLocSheet({ open: o })}
        />
      )}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Eliminar ubicación"
        description={`Se eliminará «${toDelete?.name ?? ''}». Esta acción queda registrada en la auditoría.`}
        confirmLabel="Eliminar"
        danger
        loading={delLoc.isPending}
        onConfirm={() => toDelete && delLoc.mutate(toDelete.id)}
      />
    </>
  );
}
