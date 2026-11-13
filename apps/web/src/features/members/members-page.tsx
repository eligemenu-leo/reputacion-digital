import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/use-org';
import type { Member, Role } from '@/lib/types';
import { MEMBER_STATUS } from '@/lib/labels';
import { Badge, Card, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/field';
import { Sheet } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

function mfaHint(e: unknown) {
  return e instanceof ApiError && e.code === 'MFA_REQUIRED'
    ? 'Esta acción requiere verificación en dos pasos. Actívala en Configuración → Seguridad.'
    : (e as Error).message;
}

export function MembersPage() {
  const { orgId, can, me } = useOrg();
  const [inviting, setInviting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const members = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api<Member[]>(`/organizations/${orgId}/members`),
  });
  const roles = useQuery({
    queryKey: ['roles', orgId],
    queryFn: () => api<Role[]>(`/organizations/${orgId}/roles`),
  });
  const assignableRoles =
    roles.data?.filter((r) => r.key !== 'approver' && r.key !== 'client_viewer') ?? [];

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api(`/organizations/${orgId}/members/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['members', orgId] });
      toast('success', 'Permisos actualizados');
    },
    onError: (e) => toast('error', mfaHint(e)),
  });

  const manage = can('members.manage');

  return (
    <>
      <PageHeader
        title="Usuarios y permisos"
        description="Quién accede a la organización y con qué rol. Los cambios quedan auditados."
        actions={
          manage && (
            <Button onClick={() => setInviting(true)}>
              <UserPlus className="size-4" aria-hidden />
              Invitar usuario
            </Button>
          )
        }
      />
      {members.isError && <ErrorState error={members.error} onRetry={() => members.refetch()} />}
      <Card className="overflow-hidden">
        {members.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Miembros de la organización</caption>
              <thead className="border-b border-border bg-surface-2/60 text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Usuario
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Rol
                  </th>
                  <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                    Alcance
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Estado
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.data?.map((m) => {
                  const self = m.userId === me?.user.id;
                  return (
                    <tr key={m.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium">
                          {m.fullName ?? m.email}
                          {self && <span className="ml-1.5 text-xs text-muted">(tú)</span>}
                        </p>
                        <p className="text-xs text-muted">{m.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        {manage && !self ? (
                          <Select
                            aria-label={`Rol de ${m.email}`}
                            value={m.roleId}
                            onChange={(e) =>
                              update.mutate({ id: m.id, body: { roleId: e.target.value } })
                            }
                            className="h-8 w-48 text-[13px]"
                          >
                            {assignableRoles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          m.roleName
                        )}
                      </td>
                      <td className="hidden px-4 py-3 text-muted md:table-cell">
                        {m.allClientsAccess
                          ? 'Todos los clientes'
                          : `${m.assignedClients} cliente(s) asignado(s)`}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Badge tone={MEMBER_STATUS[m.status].tone}>
                            {MEMBER_STATUS[m.status].label}
                          </Badge>
                          {manage && !self && m.status !== 'invited' && (
                            <button
                              className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
                              onClick={() =>
                                update.mutate({
                                  id: m.id,
                                  body: { status: m.status === 'active' ? 'suspended' : 'active' },
                                })
                              }
                            >
                              {m.status === 'active' ? 'Suspender' : 'Reactivar'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="text-sm font-semibold">Roles disponibles</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {roles.data?.map((r) => (
            <li key={r.id} className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">
                {r.name} {r.isSystem && <span className="text-xs text-muted">· sistema</span>}
              </p>
              <p className="mt-0.5 text-xs text-muted">{r.description}</p>
              <p className="mt-2 text-xs text-muted">{r.permissions.length} permisos</p>
            </li>
          ))}
        </ul>
      </Card>

      {inviting && (
        <InviteSheet
          orgId={orgId}
          roles={assignableRoles}
          open={inviting}
          onOpenChange={setInviting}
        />
      )}
    </>
  );
}

function InviteSheet({
  orgId,
  roles,
  open,
  onOpenChange,
}: {
  orgId: string;
  roles: Role[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('account_manager');
  const [allClientsAccess, setAll] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const invite = useMutation({
    mutationFn: () =>
      api<{ invited: boolean }>(`/organizations/${orgId}/members`, {
        method: 'POST',
        body: { email, roleKey, allClientsAccess },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['members', orgId] });
      toast('success', r.invited ? 'Invitación enviada' : 'Usuario añadido');
      onOpenChange(false);
    },
    onError: (e) => toast('error', mfaHint(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Invitar usuario"
      description="Si la persona no tiene cuenta, recibirá un email para crear su contraseña."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="invite-form" loading={invite.isPending}>
            Invitar
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" required>
          {(p) => (
            <Input
              {...p}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Rol">
          {(p) => (
            <Select {...p} value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="rounded-lg border border-border p-4">
          <Switch
            checked={allClientsAccess}
            onChange={setAll}
            label="Acceso a todos los clientes"
            description="Si se desactiva, asigna clientes concretos desde la ficha de cada cliente."
          />
        </div>
      </form>
    </Sheet>
  );
}
