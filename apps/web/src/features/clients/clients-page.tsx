import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Building2, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import type { ClientStatus } from '@rep/shared';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { ClientListItem, Paginated } from '@/lib/types';
import { CLIENT_STATUS } from '@/lib/labels';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { ClientFormSheet } from './client-form';

export function ClientsPage() {
  const { orgId, can } = useOrg();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const status = (params.get('status') ?? '') as ClientStatus | '';
  const page = Number(params.get('page') ?? '1') || 1;
  const pageSize = 25;

  // Búsqueda con debounce para no saturar la API.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search) next.set('q', search);
      else next.delete('q');
      if ((params.get('q') ?? '') !== search) {
        next.delete('page');
        setParams(next, { replace: true });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [search, params, setParams]);

  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (params.get('q')) qs.set('q', params.get('q')!);
  if (status) qs.set('status', status);

  const q = useQuery({
    queryKey: ['clients', orgId, qs.toString()],
    queryFn: () => api<Paginated<ClientListItem>>(`/organizations/${orgId}/clients?${qs}`),
    placeholderData: keepPreviousData,
  });
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / pageSize)) : 1;
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Empresas cuya reputación digital gestiona tu organización."
        actions={
          can('clients.create') && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Nuevo cliente
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            aria-label="Buscar clientes"
            placeholder="Buscar por nombre, razón social o sector"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          aria-label="Filtrar por estado"
          value={status}
          onChange={(e) => setParam('status', e.target.value)}
          className="sm:w-52"
        >
          <option value="">Todos (sin archivados)</option>
          {(Object.keys(CLIENT_STATUS) as ClientStatus[]).map((s) => (
            <option key={s} value={s}>
              {CLIENT_STATUS[s].label}
            </option>
          ))}
        </Select>
      </div>

      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <Card className="overflow-hidden">
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : q.data && q.data.items.length === 0 ? (
          <EmptyState
            icon={<Building2 className="size-5" aria-hidden />}
            title={params.get('q') || status ? 'Sin resultados' : 'Aún no hay clientes'}
            description={
              params.get('q') || status
                ? 'Prueba con otros filtros.'
                : 'Da de alta tu primer cliente para empezar a gestionar su reputación.'
            }
            action={
              !params.get('q') &&
              !status &&
              can('clients.create') && (
                <Button onClick={() => setCreating(true)}>Nuevo cliente</Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Listado de clientes</caption>
              <thead className="border-b border-border bg-surface-2/60 text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Cliente
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Estado
                  </th>
                  <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                    Responsable
                  </th>
                  <th
                    scope="col"
                    className="hidden px-4 py-2.5 text-right font-medium sm:table-cell"
                  >
                    Ubicaciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {q.data?.items.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer hover:bg-surface-2"
                    onClick={() => nav(`/o/${orgId}/clientes/${c.id}`)}
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/o/${orgId}/clientes/${c.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.name}
                      </Link>
                      {c.sector && <p className="text-xs text-muted">{c.sector}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={CLIENT_STATUS[c.status].tone}>
                        {CLIENT_STATUS[c.status].label}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 text-muted md:table-cell">
                      {c.accountManagerName ?? c.accountManagerEmail ?? '—'}
                    </td>
                    <td className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">
                      {c.locationsCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && q.data.total > pageSize && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted">
            <span>
              {q.data.total} clientes · página {page} de {totalPages}
            </span>
            <div className="flex gap-1">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setParam('page', String(page - 1))}
                aria-label="Página anterior"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setParam('page', String(page + 1))}
                aria-label="Página siguiente"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {creating && (
        <ClientFormSheet
          orgId={orgId}
          open={creating}
          onOpenChange={setCreating}
          onSaved={(id) => nav(`/o/${orgId}/clientes/${id}`)}
        />
      )}
    </>
  );
}
