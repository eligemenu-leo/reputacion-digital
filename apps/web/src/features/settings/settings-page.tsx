import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/auth-context';
import { TIMEZONES } from '@/lib/labels';
import { Badge, Card, PageHeader } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { AiSettings } from './ai-settings';

interface Org {
  id: string;
  name: string;
  defaultTimezone: string;
  publishingPaused: boolean;
  requireAdminMfa: boolean;
}

export function SettingsPage() {
  const { orgId, can } = useOrg();
  return (
    <>
      <PageHeader title="Configuración" />
      <div className="grid gap-6">
        {can('organization.manage') && <OrganizationSettings orgId={orgId} />}
        <AiSettings orgId={orgId} />
        <SecuritySettings />
      </div>
    </>
  );
}

function OrganizationSettings({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['org', orgId],
    queryFn: () => api<Org>(`/organizations/${orgId}`),
  });
  const [name, setName] = useState('');
  const [tz, setTz] = useState('Europe/Madrid');
  const [confirmPause, setConfirmPause] = useState(false);
  useEffect(() => {
    if (q.data) {
      setName(q.data.name);
      setTz(q.data.defaultTimezone);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: (
      body: Partial<{
        name: string;
        defaultTimezone: string;
        publishingPaused: boolean;
        requireAdminMfa: boolean;
      }>,
    ) => api<Org>(`/organizations/${orgId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast('success', 'Configuración guardada');
      setConfirmPause(false);
    },
    onError: (e) =>
      toast(
        'error',
        e instanceof ApiError && e.code === 'MFA_REQUIRED'
          ? 'Activa la verificación en dos pasos para cambiar la configuración.'
          : e.message,
      ),
  });

  if (!q.data) return null;
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">Organización</h2>
      <form
        className="mt-5 grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ name, defaultTimezone: tz });
        }}
      >
        <Field label="Nombre">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Zona horaria por defecto">
          {(p) => (
            <Select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
              {TIMEZONES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" loading={save.isPending}>
            Guardar
          </Button>
        </div>
      </form>
      <div className="mt-6 flex flex-col gap-5 border-t border-border pt-6">
        <Switch
          checked={q.data.publishingPaused}
          onChange={(v) => (v ? setConfirmPause(true) : save.mutate({ publishingPaused: false }))}
          label="Suspender todas las publicaciones externas"
          description="Interruptor de emergencia: ninguna respuesta se publicará en Google, Facebook o Instagram mientras esté activo."
        />
        <Switch
          checked={q.data.requireAdminMfa}
          onChange={(v) => save.mutate({ requireAdminMfa: v })}
          label="Exigir verificación en dos pasos a administradores"
          description="Recomendado. Las acciones sensibles (usuarios, roles, configuración) requerirán MFA."
        />
      </div>
      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title="¿Suspender publicaciones?"
        description="Se detendrá cualquier publicación pendiente o futura hasta que lo reactives. Quedará registrado en la auditoría."
        confirmLabel="Suspender publicaciones"
        danger
        loading={save.isPending}
        onConfirm={() => save.mutate({ publishingPaused: true })}
      />
    </Card>
  );
}

export function SecuritySettings() {
  const { refreshAal } = useAuth();
  const toast = useToast();
  const [factors, setFactors] = useState<{ id: string; friendlyName?: string; status: string }[]>(
    [],
  );
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data } = (await supabase?.auth.mfa.listFactors()) ?? { data: null };
    setFactors(data?.totp ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const start = async () => {
    setBusy(true);
    const { data, error } = await supabase!.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `TOTP ${new Date().toISOString().slice(0, 10)}`,
    });
    setBusy(false);
    if (error || !data) return toast('error', 'No se pudo iniciar la configuración de MFA');
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const verify = async () => {
    if (!enroll) return;
    setBusy(true);
    const { error } = await supabase!.auth.mfa.challengeAndVerify({
      factorId: enroll.id,
      code: code.replace(/\s/g, ''),
    });
    setBusy(false);
    if (error) return toast('error', 'Código incorrecto');
    setEnroll(null);
    setCode('');
    await refreshAal();
    await load();
    toast('success', 'Verificación en dos pasos activada');
  };

  const verified = factors.filter((f) => f.status === 'verified');
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-5 text-accent" aria-hidden />
        <h2 className="text-base font-semibold">Seguridad de tu cuenta</h2>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Verificación en dos pasos (TOTP)</p>
          <p className="text-xs text-muted">
            Usa una app como 1Password, Google Authenticator o Authy.
          </p>
        </div>
        {verified.length > 0 ? (
          <Badge tone="success">Activada</Badge>
        ) : (
          !enroll && (
            <Button variant="secondary" loading={busy} onClick={start}>
              Activar
            </Button>
          )
        )}
      </div>
      {enroll && (
        <div className="mt-5 grid gap-5 rounded-lg border border-border p-4 sm:grid-cols-[180px_1fr]">
          <img
            src={enroll.qr}
            alt="Código QR para la app de autenticación"
            className="size-44 rounded-md bg-white p-2"
          />
          <div className="flex flex-col gap-3">
            <p className="text-sm">Escanea el código o introduce esta clave manualmente:</p>
            <code className="break-all rounded bg-surface-2 px-2 py-1 text-xs">
              {enroll.secret}
            </code>
            <Field label="Código de 6 dígitos">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="max-w-40 tracking-widest"
                />
              )}
            </Field>
            <div>
              <Button onClick={verify} loading={busy} disabled={code.length < 6}>
                Verificar y activar
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
