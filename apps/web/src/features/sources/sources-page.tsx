import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Lock, Plug, Plus, RefreshCw, Unplug } from 'lucide-react';
import type { ConnectionStatus } from '@rep/shared';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { ClientListItem, Paginated } from '@/lib/types';
import {
  CONNECTION_TONE,
  SYNC_STATUS,
  connectionLabel,
  fmtDateTime,
  providerLabel,
} from '@/lib/inbox';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ConfirmDialog, Sheet } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { SimulatedBadge } from '@/features/inbox/parts';
import {
  GOOGLE_ERRORS,
  GoogleCard,
  SelectGoogleLocationsSheet,
  type IntegrationsStatus,
} from './google-connect';

interface Connection {
  id: string;
  clientId: string;
  clientName: string;
  locationName: string | null;
  provider: string;
  displayName: string;
  status: ConnectionStatus;
  isSimulated: boolean;
  capabilities: string[];
  lastSuccessSyncAt: string | null;
  nextRunAt: string | null;
  lastErrorMessage: string | null;
  canManage: boolean;
  lastRun: {
    status: string;
    itemsFound: number;
    itemsCreated: number;
    itemsUpdated: number;
    failureReason: string | null;
    finishedAt: string | null;
  } | null;
}

const PENDING_PROVIDERS = [
  { name: 'Facebook', reason: 'Pendiente de app de Meta y App Review' },
  { name: 'Instagram', reason: 'Pendiente de app de Meta y App Review' },
  { name: 'Monitorización web', reason: 'Pendiente de elegir proveedor de búsqueda' },
];

export function SourcesPage() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const [selecting, setSelecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<IntegrationsStatus>('/integrations'),
  });
  // Vuelta desde Google: ?google=<autorización> o ?google_error=<código>.
  useEffect(() => {
    const ok = params.get('google');
    const err = params.get('google_error');
    if (!ok && !err) return;
    if (ok) setSelecting(ok);
    if (err) toast('error', GOOGLE_ERRORS[err] ?? 'No se pudo conectar con Google.');
    setParams({}, { replace: true });
  }, [params, setParams, toast]);
  const q = useQuery({
    queryKey: ['connections', orgId],
    queryFn: () =>
      api<{ items: Connection[]; simulatorAvailable: boolean }>(
        `/organizations/${orgId}/connections`,
      ),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (c) =>
          c.status === 'syncing' ||
          c.lastRun?.status === 'queued' ||
          c.lastRun?.status === 'running',
      )
        ? 2000
        : false,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['connections', orgId] });
    void qc.invalidateQueries({ queryKey: ['inbox', orgId] });
  };
  const sync = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}/sync`, { method: 'POST' }),
    onSuccess: () => {
      toast('success', 'Sincronización en cola');
      refresh();
    },
    onError: (e) => toast('error', e.message),
  });
  const generate = useMutation({
    mutationFn: (id: string) =>
      api<{ generated: number }>(`/connections/${id}/simulate-reviews`, {
        method: 'POST',
        body: { count: 5 },
      }),
    onSuccess: (r) =>
      toast(
        'success',
        `${r.generated} reseñas ficticias creadas en el simulador. Sincroniza para traerlas.`,
      ),
    onError: (e) => toast('error', e.message),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) =>
      api<{ revokedAtProvider: boolean | null; credentialReleased: boolean }>(
        `/connections/${id}/disconnect`,
        { method: 'POST' },
      ),
    onSuccess: (r) => {
      toast(
        'success',
        r.credentialReleased
          ? r.revokedAtProvider
            ? 'Fuente desconectada y acceso revocado en el proveedor'
            : 'Fuente desconectada. Revisa en tu cuenta del proveedor que el acceso quedó retirado.'
          : 'Fuente desconectada',
      );
      setDisconnecting(null);
      refresh();
    },
    onError: (e) => toast('error', e.message),
  });
  const mode = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      api(`/connections/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast('success', 'Modo de prueba actualizado');
      refresh();
    },
    onError: (e) => toast('error', e.message),
  });

  return (
    <>
      <PageHeader
        title="Fuentes conectadas"
        description="Cuentas desde las que se leen reseñas y se publican respuestas."
        actions={
          q.data?.simulatorAvailable && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> Fuente simulada
            </Button>
          )
        }
      />

      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <Card className="mb-6 overflow-hidden">
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : q.data?.items.length === 0 ? (
          <EmptyState
            icon={<Plug className="size-5" aria-hidden />}
            title="Sin fuentes conectadas"
            description={
              integrations.data?.google.configured
                ? 'Conecta una ficha de Google Business Profile para empezar a recibir reseñas.'
                : 'Ninguna integración real está configurada todavía. En desarrollo puedes crear una fuente simulada con datos ficticios para probar el flujo completo.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {q.data?.items.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 p-4 xl:flex-row xl:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.displayName}</span>
                    {c.isSimulated && <SimulatedBadge />}
                    <Badge tone={CONNECTION_TONE[c.status]}>{connectionLabel(c.status)}</Badge>
                    {!c.isSimulated &&
                      c.status !== 'disconnected' &&
                      !c.capabilities.includes('publish_reply') && (
                        <Badge tone="warning">Solo lectura</Badge>
                      )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {c.clientName}
                    {c.locationName && ` · ${c.locationName}`} · {providerLabel(c.provider)} ·
                    última correcta {fmtDateTime(c.lastSuccessSyncAt)}
                  </p>
                  {c.lastRun && (
                    <p className="mt-1 text-xs text-muted">
                      Última ejecución:{' '}
                      <Badge tone={SYNC_STATUS[c.lastRun.status]?.tone ?? 'neutral'}>
                        {SYNC_STATUS[c.lastRun.status]?.label ?? c.lastRun.status}
                      </Badge>{' '}
                      {c.lastRun.itemsFound} leídas · {c.lastRun.itemsCreated} nuevas ·{' '}
                      {c.lastRun.itemsUpdated} actualizadas
                      {c.lastRun.failureReason && ` · ${c.lastRun.failureReason}`}
                    </p>
                  )}
                </div>
                {c.canManage && (
                  <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                    {c.isSimulated && (
                      <>
                        <div className="w-48">
                          <Select
                            aria-label="Modo de publicación simulado"
                            className="h-8 text-[13px]"
                            defaultValue=""
                            onChange={(e) =>
                              e.target.value &&
                              mode.mutate({ id: c.id, body: { publishMode: e.target.value } })
                            }
                          >
                            <option value="">Probar publicación…</option>
                            <option value="ok">Publicación correcta</option>
                            <option value="ambiguous">Respuesta ambigua</option>
                            <option value="rate_limited">Límite de peticiones</option>
                            <option value="error">Error del proveedor</option>
                            <option value="credentials_expired">Credenciales caducadas</option>
                          </Select>
                        </div>
                        <div className="w-48">
                          <Select
                            aria-label="Modo de sincronización simulado"
                            className="h-8 text-[13px]"
                            defaultValue=""
                            onChange={(e) =>
                              e.target.value &&
                              mode.mutate({ id: c.id, body: { syncMode: e.target.value } })
                            }
                          >
                            <option value="">Probar sincronización…</option>
                            <option value="ok">Sincronización correcta</option>
                            <option value="error">Error temporal</option>
                            <option value="credentials_expired">Credenciales caducadas</option>
                          </Select>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => generate.mutate(c.id)}
                          loading={generate.isPending && generate.variables === c.id}
                        >
                          <FlaskConical className="size-3.5" aria-hidden /> Generar reseñas
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      onClick={() => sync.mutate(c.id)}
                      loading={sync.isPending && sync.variables === c.id}
                      disabled={c.status === 'disconnected'}
                    >
                      <RefreshCw className="size-3.5" aria-hidden /> Sincronizar
                    </Button>
                    {c.status !== 'disconnected' && (
                      <Button size="sm" variant="secondary" onClick={() => setDisconnecting(c)}>
                        <Unplug className="size-3.5" aria-hidden /> Desconectar
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h2 className="mb-3 text-sm font-semibold">Integraciones reales</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <GoogleCard
          status={integrations.data?.google}
          orgId={orgId}
          canConnect={integrations.isSuccess}
        />
        {PENDING_PROVIDERS.map((p) => (
          <Card key={p.name} className="flex items-start gap-3 p-4">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div>
              <p className="text-sm font-medium">{p.name}</p>
              <p className="text-xs text-muted">No disponible · {p.reason} (Fase 4)</p>
            </div>
          </Card>
        ))}
      </div>

      {selecting && (
        <SelectGoogleLocationsSheet
          credentialId={selecting}
          onClose={() => setSelecting(null)}
          onConnected={refresh}
        />
      )}
      {disconnecting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDisconnecting(null)}
          title={`¿Desconectar «${disconnecting.displayName}»?`}
          description={
            disconnecting.isSimulated
              ? 'Se dejarán de sincronizar reseñas de esta fuente simulada.'
              : 'Se dejarán de leer reseñas y no se podrá publicar en esta ficha. Si era la última ficha con esa autorización, se revocará el acceso en el proveedor. El historial se conserva.'
          }
          confirmLabel="Desconectar"
          danger
          loading={disconnect.isPending}
          onConfirm={() => disconnect.mutate(disconnecting.id)}
        />
      )}
      {creating && (
        <CreateSimulatorSheet
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={refresh}
        />
      )}
    </>
  );
}

function CreateSimulatorSheet({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const clients = useQuery({
    queryKey: ['clients', orgId, 'all'],
    queryFn: () => api<Paginated<ClientListItem>>(`/organizations/${orgId}/clients?pageSize=100`),
  });
  const [clientId, setClientId] = useState('');
  const [name, setName] = useState('Simulador de reseñas');
  const create = useMutation({
    mutationFn: async () => {
      const r = await api<{ id: string }>(`/organizations/${orgId}/connections/simulator`, {
        method: 'POST',
        body: { clientId, displayName: name },
      });
      await api(`/connections/${r.id}/simulate-reviews`, {
        method: 'POST',
        body: { count: 12, backdateDays: 30 },
      });
      await api(`/connections/${r.id}/sync`, { method: 'POST' });
      return r;
    },
    onSuccess: () => {
      toast('success', 'Fuente simulada creada con 12 reseñas ficticias');
      onCreated();
      onClose();
    },
    onError: (e) => toast('error', e.message),
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Nueva fuente simulada"
      description="Solo para desarrollo y pruebas. Genera reseñas ficticias marcadas como «Simulado» y permite probar fallos de publicación."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!clientId || !name.trim()}
          >
            Crear y sincronizar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Cliente" required>
          {(f) => (
            <Select {...f} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Elige un cliente</option>
              {clients.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Nombre" required>
          {(f) => (
            <Input {...f} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
