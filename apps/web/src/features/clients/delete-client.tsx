import { useState } from 'react';
import * as D from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const same = (a: string) => a.trim().toLocaleLowerCase('es');

/** Zona de peligro: eliminar el cliente y todos sus datos (irreversible). */
export function DeleteClientCard({
  orgId,
  clientId,
  clientName,
}: {
  orgId: string;
  clientId: string;
  clientName: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const del = useMutation({
    mutationFn: () =>
      api<{ counts: { interactions: number; sources: number } }>(`/clients/${clientId}`, {
        method: 'DELETE',
        body: { confirmName: typed },
      }),
    onSuccess: (r) => {
      toast(
        'success',
        `Cliente «${clientName}» eliminado, con ${plural(r.counts.interactions, 'opinión o comentario', 'opiniones y comentarios')} y ${plural(r.counts.sources, 'fuente', 'fuentes')}.`,
      );
      qc.removeQueries({ queryKey: ['client', clientId] });
      void qc.invalidateQueries();
      nav(`/o/${orgId}/clientes`, { replace: true });
    },
    onError: (e) => toast('error', e.message),
  });
  const ok = same(typed) === same(clientName);

  return (
    <Card className="border-danger/40 p-5 lg:col-span-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="text-sm font-semibold text-danger">Eliminar cliente</h2>
          <p className="mt-1 text-sm text-muted">
            Borra de nuestra base de datos el cliente y todo lo suyo: fuentes conectadas, opiniones,
            reseñas y comentarios, historial, borradores, aprobaciones, análisis de IA e informes.
            No borra nada en Google, Facebook ni Instagram. No se puede deshacer.
          </p>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash2 className="size-4" aria-hidden />
          Eliminar cliente
        </Button>
      </div>
      <D.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setTyped('');
        }}
      >
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <D.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-2xl focus:outline-none">
            <D.Title className="text-base font-semibold">¿Eliminar «{clientName}»?</D.Title>
            <D.Description className="mt-2 text-sm text-muted">
              Se borrarán definitivamente todas sus fuentes, opiniones, reseñas y comentarios, con
              su historial, borradores, aprobaciones, análisis de IA e informes. En la auditoría
              solo quedará constancia de quién lo eliminó y cuándo.
            </D.Description>
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (ok) del.mutate();
              }}
            >
              <Field label={`Escribe «${clientName}» para confirmar`} required>
                {(f) => (
                  <Input
                    {...f}
                    autoComplete="off"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                )}
              </Field>
              <div className="mt-6 flex justify-end gap-2">
                <D.Close asChild>
                  <Button type="button" variant="secondary">
                    Cancelar
                  </Button>
                </D.Close>
                <Button type="submit" variant="danger" disabled={!ok} loading={del.isPending}>
                  Eliminar definitivamente
                </Button>
              </div>
            </form>
          </D.Content>
        </D.Portal>
      </D.Root>
    </Card>
  );
}
