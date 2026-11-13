import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import * as DM from '@radix-ui/react-dropdown-menu';
import {
  Bell,
  Building2,
  CheckSquare,
  ChevronsUpDown,
  FileBarChart,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plug,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useOrg } from '@/lib/use-org';
import { useAuth } from '@/features/auth/auth-context';
import type { Permission } from '@rep/shared';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm?: Permission;
  phase?: string;
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch {
      /* almacenamiento no disponible */
    }
  }, [dark]);
  return [dark, setDark] as const;
}

export function AppShell() {
  const { orgId, membership, me, can, isPlatformAdmin } = useOrg();
  const { signOut } = useAuth();
  const [dark, setDark] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = useNavigate();
  const base = `/o/${orgId}`;

  const sections: { title?: string; items: NavItem[] }[] = [
    { items: [{ to: base, label: 'Panel', icon: <LayoutDashboard /> }] },
    {
      title: 'Operativa',
      items: [
        { to: `${base}/bandeja`, label: 'Bandeja', icon: <Inbox />, phase: 'Fase 2' },
        {
          to: `${base}/aprobaciones`,
          label: 'Aprobaciones',
          icon: <CheckSquare />,
          phase: 'Fase 2',
        },
        { to: `${base}/alertas`, label: 'Alertas', icon: <Bell />, phase: 'Fase 5' },
        { to: `${base}/informes`, label: 'Informes', icon: <FileBarChart />, phase: 'Fase 5' },
      ],
    },
    {
      title: 'Gestión',
      items: [
        { to: `${base}/clientes`, label: 'Clientes', icon: <Building2 /> },
        { to: `${base}/fuentes`, label: 'Fuentes conectadas', icon: <Plug />, phase: 'Fase 4' },
        {
          to: `${base}/usuarios`,
          label: 'Usuarios y permisos',
          icon: <Users />,
          perm: 'members.manage',
        },
        { to: `${base}/auditoria`, label: 'Auditoría', icon: <ScrollText />, perm: 'audit.read' },
        { to: `${base}/ajustes`, label: 'Configuración', icon: <Settings /> },
      ],
    },
  ];

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-4 pb-3">
        <DM.Root>
          <DM.Trigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[13px] font-semibold text-accent-fg">
              {membership?.organizationName.slice(0, 1).toUpperCase() ?? '·'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {membership?.organizationName ?? 'Organización'}
              </span>
              <span className="block truncate text-xs text-muted">
                {membership?.roleName ?? (isPlatformAdmin ? 'Superadministrador' : '')}
              </span>
            </span>
            <ChevronsUpDown className="size-4 text-muted" aria-hidden />
          </DM.Trigger>
          <DM.Portal>
            <DM.Content
              align="start"
              sideOffset={6}
              className="z-50 min-w-60 rounded-lg border border-border bg-surface p-1 shadow-xl"
            >
              <DM.Label className="px-2 py-1.5 text-xs text-muted">
                Cambiar de organización
              </DM.Label>
              {me?.memberships.map((m) => (
                <DM.Item
                  key={m.organizationId}
                  onSelect={() => nav(`/o/${m.organizationId}`)}
                  className="cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2"
                >
                  {m.organizationName}
                </DM.Item>
              ))}
              {isPlatformAdmin && (
                <>
                  <DM.Separator className="my-1 h-px bg-border" />
                  <DM.Item
                    onSelect={() => nav('/admin')}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2"
                  >
                    <ShieldCheck className="size-4" aria-hidden /> Administración de plataforma
                  </DM.Item>
                </>
              )}
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </div>
      <nav aria-label="Principal" className="flex-1 overflow-y-auto px-3 pb-4">
        {sections.map((s, i) => (
          <div key={i} className="mb-4">
            {s.title && (
              <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                {s.title}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {s.items
                .filter((it) => !it.perm || can(it.perm))
                .map((it) => (
                  <li key={it.to}>
                    <NavLink
                      to={it.to}
                      end={it.to === base}
                      onClick={() => setMobileOpen(false)}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                          isActive
                            ? 'bg-surface-2 font-medium text-fg'
                            : 'text-muted hover:bg-surface-2 hover:text-fg',
                        )
                      }
                    >
                      {it.icon}
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.phase && (
                        <span className="rounded bg-surface-2 px-1.5 text-[10px] text-muted">
                          {it.phase}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 px-2">
            <p className="truncate text-sm font-medium">
              {me?.profile?.fullName ?? me?.user.email}
            </p>
            <p className="truncate text-xs text-muted">{me?.user.email}</p>
          </div>
          <button
            onClick={() => setDark(!dark)}
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
            aria-label={dark ? 'Activar modo claro' : 'Activar modo oscuro'}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button
            onClick={signOut}
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Cerrar sesión"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Saltar al contenido
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r border-border bg-surface lg:block">
        {sidebar}
      </aside>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="rounded-md p-2 hover:bg-surface-2"
          aria-label="Abrir menú"
        >
          <Menu className="size-5" />
        </button>
        <span className="truncate text-sm font-semibold">{membership?.organizationName}</span>
      </header>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menú"
        >
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-border bg-surface shadow-xl">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-3 rounded-md p-2 hover:bg-surface-2"
              aria-label="Cerrar menú"
            >
              <X className="size-4" />
            </button>
            {sidebar}
          </div>
        </div>
      )}
      <main id="main" className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
