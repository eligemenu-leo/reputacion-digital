import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Lock, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import type { ClientListItem, Paginated } from '@/lib/types';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { CopyUri, type IntegrationsStatus } from './google-connect';

/** Mensajes para los códigos que devuelve el callback de Meta. */
export const META_ERRORS: Record<string, string> = {
  access_denied: 'Has cancelado la autorización en Facebook. No se ha conectado nada.',
  invalid_state:
    'El enlace de autorización ha caducado o ya se usó. Vuelve a pulsar «Conectar Facebook e Instagram».',
  exchange_failed: 'Meta no confirmó la autorización. Inténtalo de nuevo en unos minutos.',
  missing_scope:
    'Falta el permiso para ver tus páginas. Vuelve a conectar y acepta todos los permisos.',
  forbidden: 'Tu usuario ya no tiene permiso para conectar fuentes de este cliente.',
  not_configured: 'Facebook e Instagram no están configurados en este entorno.',
};

const NAME = 'Facebook e Instagram';

export function MetaCard({
  status,
  orgId,
  canConnect,
}: {
  status: IntegrationsStatus['meta'] | undefined;
  orgId: string;
  canConnect: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!status) return <Skeleton className="h-24" />;
  if (!status.configured) {
    return (
      <Card className="flex items-start gap-3 p-4">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{NAME}</p>
          <p className="text-xs text-muted">
            No disponible · falta crear la app de Meta y configurarla en este entorno. Para clientes
            que no tengan rol en la app, Meta además tiene que aprobarla (App Review).
          </p>
          <p className="text-xs text-muted">
            URI de redirección para la app de Meta: <CopyUri value={status.redirectUri} />
          </p>
          <p className="text-xs text-muted">
            URL del webhook: <CopyUri value={status.webhookUrl} />
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card className="flex items-start gap-3 p-4">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{NAME}</p>
        <p className="text-xs text-muted">
          Disponible. Necesitas una cuenta de Facebook con acceso a la página (y a su Instagram
          profesional vinculado).
          {!status.webhooks && ' Sin avisos en tiempo real: se sincroniza cada hora.'}
        </p>
      </div>
      {canConnect && (
        <Button size="sm" onClick={() => setOpen(true)}>
          Conectar
        </Button>
      )}
      {open && <StartMetaSheet orgId={orgId} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function StartMetaSheet({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const clients = useQuery({
    queryKey: ['clients', orgId, 'all'],
    queryFn: () => api<Paginated<ClientListItem>>(`/organizations/${orgId}/clients?pageSize=100`),
  });
  const start = useMutation({
    mutationFn: () =>
      api<{ authorizationUrl: string }>(`/clients/${clientId}/connections/meta/start`, {
        method: 'POST',
      }),
    onSuccess: (r) => window.location.assign(r.authorizationUrl),
    onError: (e) => toast('error', e.message),
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Conectar Facebook e Instagram"
      description="Irás a Facebook para autorizar el acceso. Después eliges qué páginas y cuentas de Instagram conectar a este cliente. No se publica nada sin aprobación."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!clientId}>
            Ir a Facebook <ExternalLink className="size-3.5" aria-hidden />
          </Button>
        </>
      }
    >
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
    </Sheet>
  );
}

interface MetaAsset {
  provider: 'facebook_page' | 'instagram_business';
  externalId: string;
  pageId: string;
  displayName: string;
  canRead: boolean;
  canReply: boolean;
  ineligibilityReason?: string;
  alreadyConnected: boolean;
}

const keyOf = (a: Pick<MetaAsset, 'provider' | 'externalId'>) => `${a.provider}:${a.externalId}`;

export function SelectMetaAssetsSheet({
  credentialId,
  onClose,
  onConnected,
}: {
  credentialId: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const q = useQuery({
    queryKey: ['meta-assets', credentialId],
    queryFn: () =>
      api<{ clientId: string; missingScopes: string[]; items: MetaAsset[] }>(
        `/meta/credentials/${credentialId}/assets`,
      ),
    retry: false,
  });
  const client = useQuery({
    queryKey: ['client', q.data?.clientId],
    enabled: Boolean(q.data?.clientId),
    queryFn: () =>
      api<{ name: string; locations: { id: string; name: string }[] }>(
        `/clients/${q.data!.clientId}`,
      ),
  });
  const connect = useMutation({
    mutationFn: () =>
      api<{ items: { id: string }[] }>(`/meta/credentials/${credentialId}/connect`, {
        method: 'POST',
        body: {
          items: Object.entries(picked).map(([k, locationId]) => {
            const [provider, externalId] = k.split(':');
            return { provider, externalId, locationId };
          }),
        },
      }),
    onSuccess: (r) => {
      toast(
        'success',
        `${r.items.length === 1 ? 'Fuente conectada' : `${r.items.length} fuentes conectadas`}. Sincronizando comentarios…`,
      );
      onConnected();
      onClose();
    },
    onError: (e) => toast('error', e.message),
  });
  const count = Object.keys(picked).length;
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = { ...p };
      if (k in n) delete n[k];
      else n[k] = null;
      return n;
    });
  const groups = [
    { title: 'Páginas de Facebook', provider: 'facebook_page' as const },
    { title: 'Instagram profesional', provider: 'instagram_business' as const },
  ];

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Elige páginas y cuentas"
      description={
        client.data
          ? `Se conectarán al cliente «${client.data.name}».`
          : 'Páginas a las que tu cuenta de Facebook tiene acceso.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => connect.mutate()} loading={connect.isPending} disabled={!count}>
            Conectar {count > 0 ? count : ''}
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data!.items.length === 0 ? (
        <p className="text-sm text-muted">
          Esta cuenta de Facebook no gestiona ninguna página. Prueba con otra cuenta o revisa que
          marcaste las páginas al autorizar.
        </p>
      ) : (
        <div className="space-y-5">
          {q.data!.missingScopes.length > 0 && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              No se concedieron todos los permisos ({q.data!.missingScopes.join(', ')}). Algunas
              acciones no estarán disponibles; puedes volver a conectar para concederlos.
            </p>
          )}
          {groups.map((g) => {
            const items = q.data!.items.filter((a) => a.provider === g.provider);
            if (!items.length) return null;
            return (
              <fieldset key={g.provider} className="space-y-2">
                <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                  {g.title}
                </legend>
                {items.map((a) => {
                  const k = keyOf(a);
                  const checked = k in picked;
                  const inputId = `meta-${k.replace(/\W/g, '-')}`;
                  return (
                    <div
                      key={k}
                      className="rounded-lg border border-border p-3 has-[:checked]:border-accent"
                    >
                      <div className="flex items-start gap-3">
                        <input
                          id={inputId}
                          type="checkbox"
                          className="mt-1 size-4 accent-[var(--color-accent)]"
                          checked={checked}
                          disabled={a.alreadyConnected || !a.canRead}
                          onChange={() => toggle(k)}
                        />
                        <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block text-sm font-medium">{a.displayName}</span>
                          <span className="mt-1 flex flex-wrap gap-1.5">
                            {a.alreadyConnected ? (
                              <Badge tone="neutral">Ya conectada</Badge>
                            ) : !a.canRead ? (
                              <Badge tone="neutral">
                                <Lock className="size-3" aria-hidden /> Sin acceso
                              </Badge>
                            ) : a.canReply ? (
                              <Badge tone="success">Lectura y respuestas</Badge>
                            ) : (
                              <Badge tone="warning">
                                <TriangleAlert className="size-3" aria-hidden /> Solo lectura
                              </Badge>
                            )}
                          </span>
                          {a.ineligibilityReason && (
                            <span className="mt-1 block text-xs text-muted">
                              {a.ineligibilityReason}.
                            </span>
                          )}
                        </label>
                      </div>
                      {checked && (client.data?.locations.length ?? 0) > 0 && (
                        <div className="mt-3 pl-7">
                          <Field label="Ubicación del cliente">
                            {(f) => (
                              <Select
                                {...f}
                                value={picked[k] ?? ''}
                                onChange={(e) =>
                                  setPicked((p) => ({ ...p, [k]: e.target.value || null }))
                                }
                              >
                                <option value="">Sin asignar</option>
                                {client.data!.locations.map((cl) => (
                                  <option key={cl.id} value={cl.id}>
                                    {cl.name}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </Field>
                        </div>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
