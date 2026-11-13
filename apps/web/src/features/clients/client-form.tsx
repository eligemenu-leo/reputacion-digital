import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clientInputSchema, type ClientStatus } from '@rep/shared';
import { api, ApiError } from '@/lib/api';
import type { ClientDetail, Member } from '@/lib/types';
import { CLIENT_STATUS, LANGUAGES, TIMEZONES } from '@/lib/labels';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

type FormState = {
  name: string;
  legalName: string;
  sector: string;
  description: string;
  website: string;
  phone: string;
  primaryLanguage: string;
  timezone: string;
  accountManagerId: string;
  status: ClientStatus;
  businessContext: string;
  aiEnabled: boolean;
};

const empty: FormState = {
  name: '',
  legalName: '',
  sector: '',
  description: '',
  website: '',
  phone: '',
  primaryLanguage: 'es',
  timezone: 'Europe/Madrid',
  accountManagerId: '',
  status: 'onboarding',
  businessContext: '',
  aiEnabled: true,
};

function fromClient(c: ClientDetail): FormState {
  return {
    name: c.name,
    legalName: c.legalName ?? '',
    sector: c.sector ?? '',
    description: c.description ?? '',
    website: c.website ?? '',
    phone: c.phone ?? '',
    primaryLanguage: c.primaryLanguage,
    timezone: c.timezone,
    accountManagerId: c.accountManagerId ?? '',
    status: c.status,
    businessContext: c.businessContext ?? '',
    aiEnabled: c.aiEnabled,
  };
}

export function ClientFormSheet({
  orgId,
  client,
  open,
  onOpenChange,
  onSaved,
}: {
  orgId: string;
  client?: ClientDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (id: string) => void;
}) {
  const [f, setF] = useState<FormState>(client ? fromClient(client) : empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const toast = useToast();
  const members = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api<Member[]>(`/organizations/${orgId}/members`),
    enabled: open,
  });

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: (body: unknown) =>
      client
        ? api<ClientDetail>(`/clients/${client.id}`, { method: 'PATCH', body })
        : api<ClientDetail>(`/organizations/${orgId}/clients`, { method: 'POST', body }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['clients', orgId] });
      void qc.invalidateQueries({ queryKey: ['client', c.id] });
      void qc.invalidateQueries({ queryKey: ['overview', orgId] });
      toast('success', client ? 'Cliente actualizado' : 'Cliente creado');
      onOpenChange(false);
      onSaved?.(c.id);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VALIDATION' && Array.isArray(e.details)) {
        setErrors(
          Object.fromEntries(
            (e.details as { path: string; message: string }[]).map((d) => [d.path, d.message]),
          ),
        );
      } else toast('error', e.message);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, accountManagerId: f.accountManagerId || null };
    // Validación local con el mismo esquema que el servidor (el servidor vuelve a validar).
    const r = clientInputSchema.safeParse(body);
    if (!r.success) {
      setErrors(Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    save.mutate(body);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={client ? 'Editar cliente' : 'Nuevo cliente'}
      description="La información verificada del negocio se usará como contexto para la IA."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="client-form" loading={save.isPending}>
            {client ? 'Guardar cambios' : 'Crear cliente'}
          </Button>
        </>
      }
    >
      <form id="client-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2" noValidate>
        <Field label="Nombre comercial" required error={errors.name} className="sm:col-span-2">
          {(p) => (
            <Input {...p} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          )}
        </Field>
        <Field label="Razón social" error={errors.legalName}>
          {(p) => (
            <Input {...p} value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />
          )}
        </Field>
        <Field label="Sector" error={errors.sector}>
          {(p) => (
            <Input
              {...p}
              value={f.sector}
              onChange={(e) => set('sector', e.target.value)}
              placeholder="Hostelería, salud, retail…"
            />
          )}
        </Field>
        <Field label="Web" error={errors.website}>
          {(p) => (
            <Input
              {...p}
              type="url"
              inputMode="url"
              value={f.website}
              onChange={(e) => set('website', e.target.value)}
              placeholder="https://"
            />
          )}
        </Field>
        <Field label="Teléfono" error={errors.phone}>
          {(p) => (
            <Input
              {...p}
              type="tel"
              value={f.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          )}
        </Field>
        <Field label="Idioma principal">
          {(p) => (
            <Select
              {...p}
              value={f.primaryLanguage}
              onChange={(e) => set('primaryLanguage', e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Zona horaria" error={errors.timezone}>
          {(p) => (
            <Select {...p} value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Responsable de cuenta" error={errors.accountManagerId}>
          {(p) => (
            <Select
              {...p}
              value={f.accountManagerId}
              onChange={(e) => set('accountManagerId', e.target.value)}
            >
              <option value="">Sin asignar</option>
              {members.data
                ?.filter((m) => m.status === 'active')
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.fullName ?? m.email}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Estado">
          {(p) => (
            <Select
              {...p}
              value={f.status}
              onChange={(e) => set('status', e.target.value as ClientStatus)}
            >
              {(Object.keys(CLIENT_STATUS) as ClientStatus[]).map((s) => (
                <option key={s} value={s}>
                  {CLIENT_STATUS[s].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Descripción" error={errors.description} className="sm:col-span-2">
          {(p) => (
            <Textarea
              {...p}
              value={f.description}
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Información verificada del negocio"
          hint="Horarios, servicios, políticas confirmadas… La IA solo usará lo que figure aquí; nunca deducirá políticas de los comentarios."
          error={errors.businessContext}
          className="sm:col-span-2"
        >
          {(p) => (
            <Textarea
              {...p}
              rows={5}
              value={f.businessContext}
              onChange={(e) => set('businessContext', e.target.value)}
            />
          )}
        </Field>
        <div className="sm:col-span-2 rounded-lg border border-border p-4">
          <Switch
            checked={f.aiEnabled}
            onChange={(v) => set('aiEnabled', v)}
            label="Funciones de IA"
            description="Permite clasificar interacciones y proponer respuestas para este cliente."
          />
        </div>
      </form>
    </Sheet>
  );
}
