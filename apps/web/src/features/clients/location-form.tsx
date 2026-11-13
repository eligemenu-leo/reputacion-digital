import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { locationInputSchema } from '@rep/shared';
import { api } from '@/lib/api';
import type { Location } from '@/lib/types';
import { TIMEZONES } from '@/lib/labels';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

export function LocationFormSheet({
  clientId,
  location,
  open,
  onOpenChange,
}: {
  clientId: string;
  location?: Location;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [f, setF] = useState({
    name: location?.name ?? '',
    addressLine: location?.addressLine ?? '',
    city: location?.city ?? '',
    region: location?.region ?? '',
    postalCode: location?.postalCode ?? '',
    countryCode: location?.countryCode ?? 'ES',
    phone: location?.phone ?? '',
    timezone: location?.timezone ?? '',
    isPrimary: location?.isPrimary ?? false,
    isActive: location?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const toast = useToast();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: (body: unknown) =>
      location
        ? api(`/clients/${clientId}/locations/${location.id}`, { method: 'PATCH', body })
        : api(`/clients/${clientId}/locations`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
      toast('success', location ? 'Ubicación actualizada' : 'Ubicación añadida');
      onOpenChange(false);
    },
    onError: (e) => toast('error', e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, countryCode: f.countryCode || null, timezone: f.timezone || null };
    const r = locationInputSchema.safeParse(body);
    if (!r.success)
      return setErrors(
        Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])),
      );
    setErrors({});
    save.mutate(body);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={location ? 'Editar ubicación' : 'Nueva ubicación'}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="location-form" loading={save.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <form id="location-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Nombre" required error={errors.name} className="sm:col-span-2">
          {(p) => (
            <Input
              {...p}
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="p. ej. Local Centro"
              autoFocus
            />
          )}
        </Field>
        <Field label="Dirección" className="sm:col-span-2">
          {(p) => (
            <Input
              {...p}
              autoComplete="street-address"
              value={f.addressLine}
              onChange={(e) => set('addressLine', e.target.value)}
            />
          )}
        </Field>
        <Field label="Ciudad">
          {(p) => <Input {...p} value={f.city} onChange={(e) => set('city', e.target.value)} />}
        </Field>
        <Field label="Provincia / región">
          {(p) => <Input {...p} value={f.region} onChange={(e) => set('region', e.target.value)} />}
        </Field>
        <Field label="Código postal">
          {(p) => (
            <Input
              {...p}
              value={f.postalCode}
              onChange={(e) => set('postalCode', e.target.value)}
            />
          )}
        </Field>
        <Field label="País (ISO)" error={errors.countryCode}>
          {(p) => (
            <Input
              {...p}
              maxLength={2}
              value={f.countryCode}
              onChange={(e) => set('countryCode', e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label="Teléfono">
          {(p) => (
            <Input
              {...p}
              type="tel"
              value={f.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          )}
        </Field>
        <Field label="Zona horaria" hint="Vacío = la del cliente">
          {(p) => (
            <Select {...p} value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
              <option value="">Heredar del cliente</option>
              {TIMEZONES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2 flex flex-col gap-4 rounded-lg border border-border p-4">
          <Switch
            checked={f.isPrimary}
            onChange={(v) => set('isPrimary', v)}
            label="Ubicación principal"
          />
          <Switch checked={f.isActive} onChange={(v) => set('isActive', v)} label="Activa" />
        </div>
      </form>
    </Sheet>
  );
}
