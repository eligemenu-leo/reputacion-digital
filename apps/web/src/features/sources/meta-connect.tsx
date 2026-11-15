import { useId, useState, type InputHTMLAttributes } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Lock, Search, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
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
  onPickPages,
}: {
  status: IntegrationsStatus['meta'] | undefined;
  orgId: string;
  canConnect: boolean;
  /** Abre la asignación de páginas con una autorización ya existente. */
  onPickPages: (credentialId: string) => void;
}) {
  const toast = useToast();
  const creds = useQuery({
    queryKey: ['meta-credentials', orgId],
    enabled: Boolean(status?.configured && canConnect),
    queryFn: () =>
      api<{ items: { id: string; authorizedAt: string; sources: number }[] }>(
        `/organizations/${orgId}/meta/credentials`,
      ),
    retry: false,
  });
  const start = useMutation({
    mutationFn: () =>
      api<{ authorizationUrl: string }>(`/organizations/${orgId}/connections/meta/start`, {
        method: 'POST',
      }),
    onSuccess: (r) => window.location.assign(r.authorizationUrl),
    onError: (e) => toast('error', e.message),
  });
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
  const existing = creds.data?.items[0];
  return (
    <Card className="flex flex-wrap items-start gap-3 p-4">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium">{NAME}</p>
        <p className="text-xs text-muted">
          Conecta la cuenta de Facebook de la agencia una vez y asigna cada página o Instagram a su
          cliente.
          {!status.webhooks && ' Sin avisos en tiempo real: se sincroniza cada hora.'}
        </p>
      </div>
      {canConnect && (
        <div className="flex flex-wrap gap-2">
          {existing && (
            <Button size="sm" variant="secondary" onClick={() => onPickPages(existing.id)}>
              Asignar páginas
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => start.mutate()}
            loading={start.isPending}
            aria-label={
              existing ? 'Volver a autorizar en Facebook' : 'Conectar Facebook e Instagram'
            }
          >
            {existing ? 'Volver a autorizar' : 'Conectar'}
          </Button>
        </div>
      )}
    </Card>
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
  connectedTo: { clientId: string; clientName: string } | null;
}

const keyOf = (a: Pick<MetaAsset, 'provider' | 'externalId'>) => `${a.provider}:${a.externalId}`;

interface Pick_ {
  clientId: string;
  locationId: string | null;
}

/** Ubicación opcional dentro del cliente elegido. */
function LocationSelect({
  clientId,
  value,
  onChange,
}: {
  clientId: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const client = useQuery({
    queryKey: ['client', clientId],
    queryFn: () =>
      api<{ name: string; locations: { id: string; name: string }[] }>(`/clients/${clientId}`),
  });
  if (!client.data?.locations.length) return null;
  return (
    <Field label="Ubicación">
      {(f) => (
        <Select {...f} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Sin asignar</option>
          {client.data!.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Minúsculas y sin tildes, para que «llugarin» encuentre «Llugarín». */
export function normalize(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function matches(name: string, query: string) {
  const q = normalize(query);
  return !q || normalize(name).includes(q);
}

/** Selector de cliente en el que se puede escribir para filtrar. */
function ClientCombobox({
  clients,
  value,
  onChange,
  ...field
}: {
  clients: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
} & Pick<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-describedby' | 'aria-invalid'>) {
  const listId = useId();
  const selected = clients.find((c) => c.id === value);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const open = query !== null;
  const options = clients.filter((c) => matches(c.name, query ?? ''));
  const choose = (id: string) => {
    onChange(id);
    setQuery(null);
  };
  return (
    <div className="relative">
      <Input
        {...field}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Escribe para buscar un cliente"
        value={open ? query : (selected?.name ?? '')}
        onFocus={() => {
          setQuery('');
          setActive(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onBlur={() => setQuery(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) setQuery('');
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            const o = options[active];
            if (o) choose(o.id);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setQuery(null);
          }
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-surface py-1 text-sm shadow-lg"
        >
          {options.length === 0 ? (
            <li className="px-3 py-2 text-muted">Ningún cliente coincide</li>
          ) : (
            options.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={c.id === value}
                className={`cursor-pointer px-3 py-2 ${i === active ? 'bg-accent/10' : ''} ${c.id === value ? 'font-medium' : ''}`}
                onMouseEnter={() => setActive(i)}
                // mousedown para elegir antes de que el campo pierda el foco
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c.id);
                }}
              >
                {c.name}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

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
  const [picked, setPicked] = useState<Record<string, Pick_>>({});
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['meta-assets', credentialId],
    queryFn: () =>
      api<{
        organizationId: string;
        clients: { id: string; name: string }[];
        missingScopes: string[];
        items: MetaAsset[];
      }>(`/meta/credentials/${credentialId}/assets`),
    retry: false,
  });
  const entries = Object.entries(picked);
  const incomplete = entries.some(([, v]) => !v.clientId);
  const connect = useMutation({
    mutationFn: () =>
      api<{ items: { id: string }[] }>(`/meta/credentials/${credentialId}/connect`, {
        method: 'POST',
        body: {
          items: entries.map(([k, v]) => {
            const [provider, externalId] = k.split(':');
            return { provider, externalId, clientId: v.clientId, locationId: v.locationId };
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
  const count = entries.length;
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = { ...p };
      if (k in n) delete n[k];
      else
        n[k] = {
          clientId: q.data?.clients.length === 1 ? q.data.clients[0]!.id : '',
          locationId: null,
        };
      return n;
    });
  const set = (k: string, v: Partial<Pick_>) =>
    setPicked((p) => ({ ...p, [k]: { ...p[k]!, ...v } }));
  const groups = [
    { title: 'Páginas de Facebook', provider: 'facebook_page' as const },
    { title: 'Instagram profesional', provider: 'instagram_business' as const },
  ];

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="Asignar páginas a clientes"
      description="Marca cada página o cuenta de Instagram que quieras gestionar y elige su cliente. Las que no marques no se leen. No se publica nada sin aprobación."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => connect.mutate()}
            loading={connect.isPending}
            disabled={!count || incomplete}
          >
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
          {q.data!.clients.length === 0 && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              No hay clientes a los que puedas asignar fuentes. Crea uno en Clientes.
            </p>
          )}
          {q.data!.missingScopes.length > 0 && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              No se concedieron todos los permisos ({q.data!.missingScopes.join(', ')}). Algunas
              acciones no estarán disponibles; puedes volver a autorizar para concederlos.
            </p>
          )}
          {q.data!.items.length > 1 && (
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <Input
                type="search"
                aria-label="Buscar páginas"
                placeholder="Buscar página o cuenta de Instagram"
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          {search && !q.data!.items.some((a) => matches(a.displayName, search)) && (
            <p className="text-sm text-muted">Ninguna página coincide con «{search}».</p>
          )}
          {groups.map((g) => {
            // Las ya marcadas se mantienen visibles aunque no coincidan, para no perderlas de vista.
            const items = q.data!.items.filter(
              (a) =>
                a.provider === g.provider && (matches(a.displayName, search) || keyOf(a) in picked),
            );
            if (!items.length) return null;
            return (
              <fieldset key={g.provider} className="space-y-2">
                <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
                  {g.title}
                </legend>
                {items.map((a) => {
                  const k = keyOf(a);
                  const sel = picked[k];
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
                          checked={Boolean(sel)}
                          disabled={Boolean(a.connectedTo) || !a.canRead}
                          onChange={() => toggle(k)}
                        />
                        <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block text-sm font-medium">{a.displayName}</span>
                          <span className="mt-1 flex flex-wrap gap-1.5">
                            {a.connectedTo ? (
                              <Badge tone="neutral">Conectada a {a.connectedTo.clientName}</Badge>
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
                          {a.ineligibilityReason && !a.connectedTo && (
                            <span className="mt-1 block text-xs text-muted">
                              {a.ineligibilityReason}.
                            </span>
                          )}
                        </label>
                      </div>
                      {sel && (
                        <div className="mt-3 grid gap-3 pl-7 sm:grid-cols-2">
                          <Field label="Cliente" required>
                            {(f) => (
                              <ClientCombobox
                                {...f}
                                clients={q.data!.clients}
                                value={sel.clientId}
                                onChange={(clientId) => set(k, { clientId, locationId: null })}
                              />
                            )}
                          </Field>
                          {sel.clientId && (
                            <LocationSelect
                              clientId={sel.clientId}
                              value={sel.locationId}
                              onChange={(v) => set(k, { locationId: v })}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            );
          })}
          <p className="text-xs text-muted">
            Para pasar una página a otro cliente, desconéctala en Fuentes conectadas y vuelve a
            asignarla aquí.
          </p>
        </div>
      )}
    </Sheet>
  );
}
