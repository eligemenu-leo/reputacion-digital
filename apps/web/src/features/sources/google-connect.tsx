import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Copy, ExternalLink, Lock, MapPin, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import type { ClientListItem, Paginated } from '@/lib/types';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

export interface IntegrationsStatus {
  google: { configured: boolean; redirectUri: string; scope: string; missing: string[] };
  facebook: { configured: boolean };
  instagram: { configured: boolean };
}

/** Mensajes para los códigos que devuelve el callback de OAuth. */
export const GOOGLE_ERRORS: Record<string, string> = {
  access_denied: 'Has cancelado la autorización en Google. No se ha conectado nada.',
  invalid_state:
    'El enlace de autorización ha caducado o ya se usó. Vuelve a pulsar «Conectar Google».',
  exchange_failed: 'Google no confirmó la autorización. Inténtalo de nuevo en unos minutos.',
  missing_scope:
    'Falta el permiso para gestionar tus fichas de empresa. Vuelve a conectar y acepta todos los permisos.',
  forbidden: 'Tu usuario ya no tiene permiso para conectar fuentes de este cliente.',
  not_configured: 'Google Business Profile no está configurado en este entorno.',
};

export function GoogleCard({
  status,
  orgId,
  canConnect,
}: {
  status: IntegrationsStatus['google'] | undefined;
  orgId: string;
  canConnect: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  if (!status) return <Skeleton className="h-24" />;
  if (!status.configured) {
    return (
      <Card className="flex items-start gap-3 p-4">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Google Business Profile</p>
          <p className="text-xs text-muted">
            No disponible · falta configurar el cliente OAuth de Google y que Google apruebe el
            acceso a la API.
          </p>
          <p className="text-xs text-muted">
            URI de redirección para Google Cloud:{' '}
            <button
              type="button"
              className="inline-flex max-w-full items-center gap-1 break-all rounded font-mono text-[11px] text-fg underline decoration-dotted underline-offset-2"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(status.redirectUri)
                  .then(() => toast('success', 'URI copiada'))
              }
            >
              {status.redirectUri} <Copy className="size-3 shrink-0" aria-hidden />
            </button>
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card className="flex items-start gap-3 p-4">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Google Business Profile</p>
        <p className="text-xs text-muted">
          Disponible. Necesitas una cuenta de Google con acceso de propietario o administrador a la
          ficha.
        </p>
      </div>
      {canConnect && (
        <Button size="sm" onClick={() => setOpen(true)}>
          Conectar Google
        </Button>
      )}
      {open && <StartGoogleSheet orgId={orgId} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function StartGoogleSheet({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const toast = useToast();
  const [clientId, setClientId] = useState('');
  const clients = useQuery({
    queryKey: ['clients', orgId, 'all'],
    queryFn: () => api<Paginated<ClientListItem>>(`/organizations/${orgId}/clients?pageSize=100`),
  });
  const start = useMutation({
    mutationFn: () =>
      api<{ authorizationUrl: string }>(`/clients/${clientId}/connections/google/start`, {
        method: 'POST',
      }),
    onSuccess: (r) => window.location.assign(r.authorizationUrl),
    onError: (e) => toast('error', e.message),
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Conectar Google Business Profile"
      description="Irás a Google para autorizar el acceso. Después eliges qué fichas conectar a este cliente. No se publica nada sin aprobación."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!clientId}>
            Ir a Google <ExternalLink className="size-3.5" aria-hidden />
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

interface GoogleLocation {
  externalId: string;
  displayName: string;
  address?: string;
  canReply: boolean;
  ineligibilityReason?: string;
  alreadyConnected: boolean;
}

export function SelectGoogleLocationsSheet({
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
    queryKey: ['google-locations', credentialId],
    queryFn: () =>
      api<{
        clientId: string;
        accounts: { externalId: string; displayName: string; locations: GoogleLocation[] }[];
      }>(`/google/credentials/${credentialId}/locations`),
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
      api<{ items: { id: string }[] }>(`/google/credentials/${credentialId}/connect`, {
        method: 'POST',
        body: {
          items: Object.entries(picked).map(([externalLocationId, locationId]) => ({
            externalLocationId,
            locationId,
          })),
        },
      }),
    onSuccess: (r) => {
      toast(
        'success',
        `${r.items.length === 1 ? 'Ficha conectada' : `${r.items.length} fichas conectadas`}. Sincronizando reseñas…`,
      );
      onConnected();
      onClose();
    },
    onError: (e) => toast('error', e.message),
  });
  const count = Object.keys(picked).length;
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = { ...p };
      if (id in n) delete n[id];
      else n[id] = null;
      return n;
    });

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Elige las fichas de Google"
      description={
        client.data
          ? `Se conectarán al cliente «${client.data.name}».`
          : 'Fichas a las que tu cuenta de Google tiene acceso.'
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
      ) : q.data!.accounts.every((a) => a.locations.length === 0) ? (
        <p className="text-sm text-muted">
          Esta cuenta de Google no gestiona ninguna ficha de empresa. Prueba con otra cuenta.
        </p>
      ) : (
        <div className="space-y-5">
          {q.data!.accounts.map((a) => (
            <fieldset key={a.externalId} className="space-y-2">
              <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {a.displayName}
              </legend>
              {a.locations.map((l) => {
                const checked = l.externalId in picked;
                const inputId = `loc-${l.externalId.replace(/\W/g, '-')}`;
                return (
                  <div
                    key={l.externalId}
                    className="rounded-lg border border-border p-3 has-[:checked]:border-accent"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        id={inputId}
                        type="checkbox"
                        className="mt-1 size-4 accent-[var(--color-accent)]"
                        checked={checked}
                        disabled={l.alreadyConnected}
                        onChange={() => toggle(l.externalId)}
                      />
                      <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                        <span className="block text-sm font-medium">{l.displayName}</span>
                        {l.address && (
                          <span className="flex items-center gap-1 text-xs text-muted">
                            <MapPin className="size-3" aria-hidden /> {l.address}
                          </span>
                        )}
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          {l.alreadyConnected ? (
                            <Badge tone="neutral">Ya conectada</Badge>
                          ) : l.canReply ? (
                            <Badge tone="success">Lectura y respuestas</Badge>
                          ) : (
                            <Badge tone="warning">
                              <TriangleAlert className="size-3" aria-hidden /> Solo lectura
                            </Badge>
                          )}
                        </span>
                        {!l.canReply && l.ineligibilityReason && (
                          <span className="mt-1 block text-xs text-muted">
                            {l.ineligibilityReason}. Las reseñas se leerán, pero no se podrá
                            responder hasta que Google lo permita.
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
                              value={picked[l.externalId] ?? ''}
                              onChange={(e) =>
                                setPicked((p) => ({
                                  ...p,
                                  [l.externalId]: e.target.value || null,
                                }))
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
          ))}
        </div>
      )}
    </Sheet>
  );
}
