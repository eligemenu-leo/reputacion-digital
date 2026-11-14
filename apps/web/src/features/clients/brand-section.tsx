import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { brandVersionInputSchema } from '@rep/shared';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/inbox';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

interface BrandVersion {
  id: string;
  version: number;
  tone: string | null;
  formality: number | null;
  addressForm: 'tu' | 'usted' | 'auto';
  responseLanguage: string | null;
  recommendedExpressions: string[];
  forbiddenExpressions: string[];
  emojiPolicy: 'none' | 'moderate' | 'free';
  preferredLength: 'short' | 'medium' | 'long';
  approvedExamples: { text: string }[];
  extraInstructions: string | null;
  verifiedBusinessInfo: Record<string, string>;
  changeNote: string | null;
  createdAt: string;
  createdByName: string | null;
}
interface BrandResponse {
  current: BrandVersion | null;
  history: {
    id: string;
    version: number;
    changeNote: string | null;
    createdAt: string;
    createdByName: string | null;
  }[];
  canEdit: boolean;
}

interface FormState {
  tone: string;
  formality: string;
  addressForm: BrandVersion['addressForm'];
  responseLanguage: string;
  recommended: string;
  forbidden: string;
  emojiPolicy: BrandVersion['emojiPolicy'];
  preferredLength: BrandVersion['preferredLength'];
  examples: string;
  extraInstructions: string;
  facts: string;
  changeNote: string;
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function toForm(v: BrandVersion | null): FormState {
  return {
    tone: v?.tone ?? '',
    formality: String(v?.formality ?? 3),
    addressForm: v?.addressForm ?? 'auto',
    responseLanguage: v?.responseLanguage ?? '',
    recommended: (v?.recommendedExpressions ?? []).join('\n'),
    forbidden: (v?.forbiddenExpressions ?? []).join('\n'),
    emojiPolicy: v?.emojiPolicy ?? 'none',
    preferredLength: v?.preferredLength ?? 'medium',
    examples: (v?.approvedExamples ?? []).map((e) => e.text).join('\n---\n'),
    extraInstructions: v?.extraInstructions ?? '',
    facts: Object.entries(v?.verifiedBusinessInfo ?? {})
      .map(([k, val]) => `${k}: ${val}`)
      .join('\n'),
    changeNote: '',
  };
}

function toInput(f: FormState) {
  const facts: Record<string, string> = {};
  for (const l of lines(f.facts)) {
    const i = l.indexOf(':');
    if (i > 0) facts[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return {
    tone: f.tone.trim() || null,
    formality: Number(f.formality),
    addressForm: f.addressForm,
    responseLanguage: f.responseLanguage.trim() || null,
    recommendedExpressions: lines(f.recommended),
    forbiddenExpressions: lines(f.forbidden),
    emojiPolicy: f.emojiPolicy,
    preferredLength: f.preferredLength,
    approvedExamples: f.examples
      .split(/\n-{3,}\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ text })),
    extraInstructions: f.extraInstructions.trim() || null,
    verifiedBusinessInfo: facts,
    changeNote: f.changeNote.trim() || null,
  };
}

/** Personalidad de marca versionada. Cada guardado crea una versión nueva; la IA usa la vigente. */
export function BrandSection({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['brand', clientId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<BrandResponse>(`/clients/${clientId}/brand`),
  });
  const [f, setF] = useState<FormState>(toForm(null));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setF(toForm(q.data.current));
  }, [q.data]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<{ version: number }>(`/clients/${clientId}/brand`, { method: 'POST', body }),
    onSuccess: (r) => {
      toast('success', `Guardada la versión ${r.version}`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (q.isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const ro = !d.canEdit;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = brandVersionInputSchema.safeParse(toInput(f));
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '));
      return;
    }
    save.mutate(parsed.data);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="p-5 lg:col-span-2">
        <form onSubmit={submit} className="space-y-4" aria-label="Personalidad de marca">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Personalidad de marca</h2>
            {d.current ? (
              <Badge tone="accent">Versión vigente: {d.current.version}</Badge>
            ) : (
              <Badge tone="warning">Sin configurar: la IA no puede redactar</Badge>
            )}
          </div>
          <p className="text-xs text-muted">
            La IA solo afirma lo que aparece en «Datos verificados». Cada guardado crea una versión
            nueva y las respuestas generadas registran qué versión usaron.
          </p>
          <Field label="Tono" hint="P. ej.: cercano, profesional y con un toque de humor">
            {(p) => (
              <Input
                {...p}
                value={f.tone}
                disabled={ro}
                maxLength={300}
                onChange={(e) => set('tone', e.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Formalidad (1-5)">
              {(p) => (
                <Select
                  {...p}
                  value={f.formality}
                  disabled={ro}
                  onChange={(e) => set('formality', e.target.value)}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Tratamiento">
              {(p) => (
                <Select
                  {...p}
                  value={f.addressForm}
                  disabled={ro}
                  onChange={(e) => set('addressForm', e.target.value as FormState['addressForm'])}
                >
                  <option value="auto">Automático</option>
                  <option value="tu">Tú</option>
                  <option value="usted">Usted</option>
                </Select>
              )}
            </Field>
            <Field label="Idioma de respuesta" hint="Vacío = el del cliente">
              {(p) => (
                <Input
                  {...p}
                  value={f.responseLanguage}
                  disabled={ro}
                  placeholder="es"
                  onChange={(e) => set('responseLanguage', e.target.value)}
                />
              )}
            </Field>
            <Field label="Emojis">
              {(p) => (
                <Select
                  {...p}
                  value={f.emojiPolicy}
                  disabled={ro}
                  onChange={(e) => set('emojiPolicy', e.target.value as FormState['emojiPolicy'])}
                >
                  <option value="none">Ninguno</option>
                  <option value="moderate">Con moderación</option>
                  <option value="free">Libres</option>
                </Select>
              )}
            </Field>
            <Field label="Longitud">
              {(p) => (
                <Select
                  {...p}
                  value={f.preferredLength}
                  disabled={ro}
                  onChange={(e) =>
                    set('preferredLength', e.target.value as FormState['preferredLength'])
                  }
                >
                  <option value="short">Breve</option>
                  <option value="medium">Media</option>
                  <option value="long">Desarrollada</option>
                </Select>
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Expresiones recomendadas" hint="Una por línea">
              {(p) => (
                <Textarea
                  {...p}
                  rows={4}
                  value={f.recommended}
                  disabled={ro}
                  onChange={(e) => set('recommended', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Expresiones prohibidas"
              hint="Una por línea. Un borrador que las use se rechaza."
            >
              {(p) => (
                <Textarea
                  {...p}
                  rows={4}
                  value={f.forbidden}
                  disabled={ro}
                  onChange={(e) => set('forbidden', e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field
            label="Datos verificados del negocio"
            hint="Uno por línea, «clave: valor». P. ej.: horario: de martes a domingo, 13:00-23:00"
          >
            {(p) => (
              <Textarea
                {...p}
                rows={5}
                value={f.facts}
                disabled={ro}
                onChange={(e) => set('facts', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Ejemplos de respuestas aprobadas"
            hint="Separa cada ejemplo con una línea que solo contenga ---"
          >
            {(p) => (
              <Textarea
                {...p}
                rows={4}
                value={f.examples}
                disabled={ro}
                onChange={(e) => set('examples', e.target.value)}
              />
            )}
          </Field>
          <Field label="Instrucciones adicionales">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                maxLength={4000}
                value={f.extraInstructions}
                disabled={ro}
                onChange={(e) => set('extraInstructions', e.target.value)}
              />
            )}
          </Field>
          {!ro && (
            <>
              <Field label="Nota del cambio" hint="Opcional: qué cambia en esta versión">
                {(p) => (
                  <Input
                    {...p}
                    value={f.changeNote}
                    maxLength={500}
                    onChange={(e) => set('changeNote', e.target.value)}
                  />
                )}
              </Field>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
              <Button type="submit" loading={save.isPending}>
                Guardar nueva versión
              </Button>
            </>
          )}
          {ro && (
            <p className="text-xs text-muted">
              Solo lectura: no tienes permiso para editar la marca.
            </p>
          )}
        </form>
      </Card>
      <Card className="p-5">
        <h2 className="text-sm font-semibold">Versiones</h2>
        {d.history.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Todavía no hay versiones.</p>
        ) : (
          <ol className="mt-2 space-y-2 text-sm">
            {d.history.map((h) => (
              <li key={h.id} className="rounded-md border border-border p-2">
                <p className="font-medium">
                  Versión {h.version}
                  {d.current?.id === h.id && (
                    <span className="ml-1 text-xs text-accent">(vigente)</span>
                  )}
                </p>
                <p className="text-xs text-muted">
                  {fmtDateTime(h.createdAt)}
                  {h.createdByName && ` · ${h.createdByName}`}
                </p>
                {h.changeNote && <p className="mt-1 text-xs">{h.changeNote}</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
