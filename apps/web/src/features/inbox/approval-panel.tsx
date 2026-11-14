import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, CornerUpLeft, ShieldAlert, X } from 'lucide-react';
import { responseHash } from '@rep/shared';
import { api } from '@/lib/api';
import { providerLabel, type Draft } from '@/lib/inbox';
import { Card } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { AiDraftNotice } from './ai-panel';

/**
 * Decisión del aprobador. El hash se calcula en el navegador sobre el texto
 * EXACTO que se muestra: si alguien lo cambia entretanto, el servidor rechaza
 * la aprobación.
 */
export function ApprovalPanel({
  interactionId,
  draft,
  requiresSpecialist,
  isSimulated,
  provider,
  onDone,
  compact,
}: {
  interactionId: string;
  draft: Pick<Draft, 'content' | 'version'> & Partial<Pick<Draft, 'ai'>>;
  requiresSpecialist: boolean;
  isSimulated: boolean;
  provider: string;
  onDone: () => void;
  compact?: boolean;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [specialist, setSpecialist] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const decide = useMutation({
    mutationFn: async (decision: 'approve' | 'reject' | 'return') =>
      api<{ jobId: string | null }>(`/interactions/${interactionId}/decision`, {
        method: 'POST',
        body: {
          decision,
          note: note.trim() || undefined,
          specialistReviewed: specialist,
          contentHash: await responseHash(draft.content),
        },
      }),
    onSuccess: (_r, decision) => {
      setConfirming(false);
      toast(
        'success',
        decision === 'approve'
          ? 'Aprobada. Se publicará y verificará automáticamente.'
          : decision === 'reject'
            ? 'Respuesta rechazada'
            : 'Devuelta al gestor',
      );
      onDone();
    },
    onError: (e) => {
      setConfirming(false);
      toast('error', e.message);
    },
  });
  const needNote = () => {
    if (!note.trim()) {
      toast('error', 'Indica el motivo en la nota');
      return false;
    }
    return true;
  };
  const destination = isSimulated
    ? 'el proveedor simulado (datos ficticios)'
    : providerLabel(provider);

  return (
    <Card className={compact ? 'p-4' : 'border-warning/40 p-5'}>
      {!compact && <h2 className="text-sm font-semibold">Aprobación</h2>}
      <p className="mt-1 text-xs text-muted">
        Texto exacto que se publicará (versión {draft.version}):
      </p>
      <p className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-3 text-sm">
        {draft.content}
      </p>
      <AiDraftNotice draft={draft} />
      {requiresSpecialist && (
        <label className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
          <input
            type="checkbox"
            checked={specialist}
            onChange={(e) => setSpecialist(e.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>
            <ShieldAlert className="mr-1 inline size-3.5" aria-hidden />
            Confirmo que esta respuesta ha pasado la revisión especializada necesaria (legal,
            sanitaria u otra).
          </span>
        </label>
      )}
      <Field label="Nota (obligatoria para rechazar o devolver)" className="mt-3">
        {(f) => (
          <Textarea
            {...f}
            rows={2}
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          onClick={() => setConfirming(true)}
          disabled={requiresSpecialist && !specialist}
          loading={decide.isPending && decide.variables === 'approve'}
        >
          <Check className="size-4" aria-hidden /> Aprobar y publicar
        </Button>
        <Button
          variant="secondary"
          onClick={() => needNote() && decide.mutate('return')}
          loading={decide.isPending && decide.variables === 'return'}
        >
          <CornerUpLeft className="size-4" aria-hidden /> Devolver
        </Button>
        <Button
          variant="ghost"
          className="text-danger"
          onClick={() => needNote() && decide.mutate('reject')}
          loading={decide.isPending && decide.variables === 'reject'}
        >
          <X className="size-4" aria-hidden /> Rechazar
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="¿Aprobar y publicar?"
        description={`Esta respuesta se publicará en ${destination} tal como aparece. Si después se edita, la aprobación quedará anulada.`}
        confirmLabel="Aprobar y publicar"
        loading={decide.isPending}
        onConfirm={() => decide.mutate('approve')}
      />
    </Card>
  );
}
