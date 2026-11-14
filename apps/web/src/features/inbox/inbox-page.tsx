import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Inbox, Search, UserRound } from 'lucide-react';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { ClientListItem, Paginated } from '@/lib/types';
import { fmtShort, providerLabel, type InboxResponse } from '@/lib/inbox';
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { PriorityBadge, RiskBadges, SimulatedBadge, Stars, StateBadge } from './parts';

const VIEWS = [
  {
    key: 'open',
    label: 'Abiertas',
    states:
      'new,analyzed,pending_response,draft_generated,pending_approval,approved,publishing,publish_failed',
  },
  { key: 'todo', label: 'Por responder', states: 'new,analyzed,pending_response,draft_generated' },
  { key: 'approval', label: 'En aprobación', states: 'pending_approval' },
  { key: 'failed', label: 'Con error', states: 'publish_failed' },
  { key: 'done', label: 'Cerradas', states: 'published,discarded,closed_no_response' },
  { key: 'all', label: 'Todas', states: '' },
] as const;

type BatchAction =
  | 'assign_me'
  | 'unassign'
  | 'set_priority'
  | 'mark_needs_response'
  | 'discard'
  | 'close_without_response';

export function InboxPage() {
  const { orgId, me } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<BatchAction | null>(null);
  const [batchPriority, setBatchPriority] = useState('3');
  const view = VIEWS.find((v) => v.key === params.get('view')) ?? VIEWS[0];
  const page = Number(params.get('page') ?? '1') || 1;
  const pageSize = 25;

  // Se parte siempre de los parámetros más recientes: el buscador con retardo no debe
  // pisar filtros cambiados entretanto.
  const latestParams = useRef(params);
  latestParams.current = params;
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(latestParams.current);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    latestParams.current = next;
    setParams(next);
    setSelected(new Set());
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((latestParams.current.get('q') ?? '') !== search) setParam('q', search);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (view.states) qs.set('state', view.states);
  for (const k of [
    'q',
    'clientId',
    'priority',
    'ratingMax',
    'assignee',
    'sort',
    'dir',
    'provider',
  ]) {
    const v = params.get(k);
    if (v) qs.set(k, v);
  }
  const q = useQuery({
    queryKey: ['inbox', orgId, qs.toString()],
    queryFn: () => api<InboxResponse>(`/organizations/${orgId}/interactions?${qs}`),
    placeholderData: keepPreviousData,
  });
  const clients = useQuery({
    queryKey: ['clients', orgId, 'all'],
    queryFn: () => api<Paginated<ClientListItem>>(`/organizations/${orgId}/clients?pageSize=100`),
  });
  const totalPages = q.data ? Math.max(1, Math.ceil(q.data.total / pageSize)) : 1;
  const items = q.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  const batch = useMutation({
    mutationFn: (action: BatchAction) => {
      const ids = [...selected];
      const body =
        action === 'assign_me'
          ? { ids, action: 'assign', assigneeId: me?.user.id }
          : action === 'unassign'
            ? { ids, action: 'assign', assigneeId: null }
            : action === 'set_priority'
              ? { ids, action, priority: Number(batchPriority) }
              : { ids, action };
      return api<{ succeeded: number; failed: number; results: { ok: boolean; error?: string }[] }>(
        `/organizations/${orgId}/interactions/batch`,
        { method: 'POST', body },
      );
    },
    onSuccess: (r) => {
      setConfirm(null);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['inbox', orgId] });
      if (r.failed === 0) toast('success', `${r.succeeded} actualizadas`);
      else
        toast(
          'error',
          `${r.succeeded} actualizadas, ${r.failed} no se pudieron cambiar (${r.results.find((x) => !x.ok)?.error ?? 'error'})`,
        );
    },
    onError: (e) => toast('error', e.message),
  });

  const counts = q.data?.counts;

  return (
    <>
      <PageHeader
        title="Bandeja"
        description="Reseñas, comentarios y menciones de todos tus clientes en un solo lugar."
      />

      <div className="mb-4 flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Vistas">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            role="tab"
            aria-selected={v.key === view.key}
            onClick={() => setParam('view', v.key === 'open' ? '' : v.key)}
            className={cn(
              'h-8 shrink-0 rounded-lg px-3 text-[13px] font-medium',
              v.key === view.key ? 'bg-fg text-bg' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {v.label}
            {counts &&
              v.key === 'approval' &&
              counts.pendingApproval > 0 &&
              ` · ${counts.pendingApproval}`}
            {counts &&
              v.key === 'failed' &&
              counts.publishFailed > 0 &&
              ` · ${counts.publishFailed}`}
            {counts && v.key === 'open' && ` · ${counts.open}`}
          </button>
        ))}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <div className="relative sm:col-span-2 lg:col-span-1 2xl:col-span-2">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            aria-label="Buscar en la bandeja"
            placeholder="Buscar texto o autor"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          aria-label="Cliente"
          value={params.get('clientId') ?? ''}
          onChange={(e) => setParam('clientId', e.target.value)}
        >
          <option value="">Todos los clientes</option>
          {clients.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Prioridad"
          value={params.get('priority') ?? ''}
          onChange={(e) => setParam('priority', e.target.value)}
        >
          <option value="">Cualquier prioridad</option>
          <option value="4">Crítica</option>
          <option value="3,4">Alta o crítica</option>
          <option value="2">Normal</option>
          <option value="1">Baja</option>
        </Select>
        <Select
          aria-label="Valoración"
          value={params.get('ratingMax') ?? ''}
          onChange={(e) => setParam('ratingMax', e.target.value)}
        >
          <option value="">Cualquier valoración</option>
          <option value="2">2 estrellas o menos</option>
          <option value="3">3 estrellas o menos</option>
        </Select>
        <Select
          aria-label="Orden"
          value={`${params.get('sort') ?? 'date'}:${params.get('dir') ?? 'desc'}`}
          onChange={(e) => {
            const [s, d] = e.target.value.split(':');
            const next = new URLSearchParams(params);
            next.set('sort', s!);
            next.set('dir', d!);
            next.delete('page');
            setParams(next);
          }}
        >
          <option value="date:desc">Más recientes</option>
          <option value="date:asc">Más antiguas</option>
          <option value="priority:desc">Mayor prioridad</option>
          <option value="rating:asc">Peor valoración</option>
        </Select>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Button
          size="sm"
          variant={params.get('assignee') === 'me' ? 'primary' : 'secondary'}
          onClick={() => setParam('assignee', params.get('assignee') === 'me' ? '' : 'me')}
        >
          <UserRound className="size-3.5" aria-hidden /> Asignadas a mí
        </Button>
        <Button
          size="sm"
          variant={params.get('assignee') === 'none' ? 'primary' : 'secondary'}
          onClick={() => setParam('assignee', params.get('assignee') === 'none' ? '' : 'none')}
        >
          Sin asignar
        </Button>
        {q.data && <span className="ml-auto text-muted">{q.data.total} resultados</span>}
      </div>

      {selected.size > 0 && (
        <div
          className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-2 shadow-lg"
          role="region"
          aria-label="Acciones por lotes"
        >
          <span className="px-2 text-sm font-medium">{selected.size} seleccionadas</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => batch.mutate('assign_me')}
            loading={batch.isPending}
          >
            Asignarme
          </Button>
          <Button size="sm" variant="secondary" onClick={() => batch.mutate('unassign')}>
            Quitar asignación
          </Button>
          <div className="flex items-center gap-1">
            <Select
              aria-label="Prioridad para el lote"
              value={batchPriority}
              onChange={(e) => setBatchPriority(e.target.value)}
              className="h-8 w-28 text-[13px]"
            >
              <option value="1">Baja</option>
              <option value="2">Normal</option>
              <option value="3">Alta</option>
              <option value="4">Crítica</option>
            </Select>
            <Button size="sm" variant="secondary" onClick={() => batch.mutate('set_priority')}>
              Cambiar prioridad
            </Button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => batch.mutate('mark_needs_response')}>
            Marcar pendiente
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirm('close_without_response')}
          >
            Cerrar sin respuesta
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm('discard')}>
            Descartar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
            className="ml-auto"
          >
            Cancelar
          </Button>
        </div>
      )}

      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      <Card className="overflow-hidden">
        {q.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-5" aria-hidden />}
            title="No hay interacciones"
            description={
              params.toString()
                ? 'Prueba con otros filtros.'
                : 'Cuando conectes una fuente y se sincronice, sus reseñas aparecerán aquí.'
            }
            action={
              <Link
                to={`/o/${orgId}/fuentes`}
                className="text-sm font-medium text-accent hover:underline"
              >
                Ir a fuentes
              </Link>
            }
          />
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2 text-xs text-muted">
              <input
                type="checkbox"
                aria-label="Seleccionar todas las de esta página"
                checked={allSelected}
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))
                }
                className="size-4 accent-[var(--color-accent)]"
              />
              Seleccionar página
            </div>
            <ul className="divide-y divide-border">
              {items.map((i) => (
                <li key={i.id} className="flex gap-3 px-4 py-3 hover:bg-surface-2/60">
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar reseña de ${i.authorDisplayName ?? 'autor desconocido'}`}
                    checked={selected.has(i.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(i.id)) next.delete(i.id);
                      else next.add(i.id);
                      setSelected(next);
                    }}
                    className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <Link to={`/o/${orgId}/bandeja/${i.id}`} className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                      <span className="font-medium text-fg">
                        {i.authorDisplayName ?? 'Anónimo'}
                      </span>
                      <Stars rating={i.rating} scale={i.ratingScale} />
                      <span>·</span>
                      <span>{i.clientName}</span>
                      <span>·</span>
                      <span>{providerLabel(i.provider)}</span>
                      <span>·</span>
                      <time dateTime={i.originalCreatedAt}>{fmtShort(i.originalCreatedAt)}</time>
                    </div>
                    <p
                      className={cn('mt-1 line-clamp-2 text-sm', !i.content && 'italic text-muted')}
                    >
                      {i.content ?? 'Valoración sin texto'}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <StateBadge state={i.state} />
                      {i.priority !== 2 && <PriorityBadge priority={i.priority} />}
                      <RiskBadges flags={i.riskFlags} />
                      {i.isSimulated && <SimulatedBadge />}
                      {i.assigneeName && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted">
                          <UserRound className="size-3" aria-hidden /> {i.assigneeName}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        {q.data && q.data.total > pageSize && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted">
            <span>
              Página {page} de {totalPages}
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

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'discard' ? 'Descartar interacciones' : 'Cerrar sin respuesta'}
        description={`Se aplicará a ${selected.size} interacciones. Las que tengan una publicación en curso no se modificarán. Podrás reabrirlas después.`}
        confirmLabel={confirm === 'discard' ? 'Descartar' : 'Cerrar'}
        danger={confirm === 'discard'}
        loading={batch.isPending}
        onConfirm={() => confirm && batch.mutate(confirm)}
      />
    </>
  );
}
