import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isConfigured } from '@/lib/env';
import { ApiError } from '@/lib/api';
import { AuthProvider, useAuth, useMe } from '@/features/auth/auth-context';
import { LoginPage } from '@/features/auth/login-page';
import { RecoverPage } from '@/features/auth/recover-page';
import { ResetPasswordPage } from '@/features/auth/reset-password-page';
import { MfaPage } from '@/features/auth/mfa-page';
import { NotConfiguredPage } from '@/features/auth/not-configured-page';
import { AppShell } from '@/layouts/app-shell';
import { ComingSoonPage } from '@/pages/coming-soon-page';
import { ToastProvider } from '@/components/ui/toast';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';

const DashboardPage = lazy(() =>
  import('@/features/dashboard/dashboard-page').then((m) => ({ default: m.DashboardPage })),
);
const ClientsPage = lazy(() =>
  import('@/features/clients/clients-page').then((m) => ({ default: m.ClientsPage })),
);
const ClientDetailPage = lazy(() =>
  import('@/features/clients/client-detail-page').then((m) => ({ default: m.ClientDetailPage })),
);
const MembersPage = lazy(() =>
  import('@/features/members/members-page').then((m) => ({ default: m.MembersPage })),
);
const AuditPage = lazy(() =>
  import('@/features/audit/audit-page').then((m) => ({ default: m.AuditPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
);
const AccountPage = lazy(() =>
  import('@/features/settings/account-page').then((m) => ({ default: m.AccountPage })),
);
const InboxPage = lazy(() =>
  import('@/features/inbox/inbox-page').then((m) => ({ default: m.InboxPage })),
);
const InteractionPage = lazy(() =>
  import('@/features/inbox/interaction-page').then((m) => ({ default: m.InteractionPage })),
);
const ApprovalsPage = lazy(() =>
  import('@/features/approvals/approvals-page').then((m) => ({ default: m.ApprovalsPage })),
);
const SourcesPage = lazy(() =>
  import('@/features/sources/sources-page').then((m) => ({ default: m.SourcesPage })),
);
const AdminPage = lazy(() =>
  import('@/features/admin/admin-page').then((m) => ({ default: m.AdminPage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function FullscreenLoader() {
  return (
    <div className="grid min-h-dvh place-items-center" aria-busy="true" aria-label="Cargando">
      <Skeleton className="h-2 w-40" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, needsMfa } = useAuth();
  const location = useLocation();
  if (loading) return <FullscreenLoader />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (needsMfa) return <Navigate to="/mfa" replace />;
  return <>{children}</>;
}

function HomeRedirect() {
  const me = useMe();
  if (me.isLoading) return <FullscreenLoader />;
  if (me.isError)
    return (
      <div className="p-8">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  const first = me.data?.memberships[0];
  if (first) return <Navigate to={`/o/${first.organizationId}`} replace />;
  if (me.data?.isPlatformAdmin) return <Navigate to="/admin" replace />;
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <EmptyState
        title="Sin organización asignada"
        description="Tu cuenta aún no pertenece a ninguna organización. Pide a un administrador que te invite."
      />
    </main>
  );
}

function OrgGuard({ children }: { children: ReactNode }) {
  const me = useMe();
  const { pathname } = useLocation();
  const orgId = pathname.split('/')[2];
  if (me.isLoading) return <FullscreenLoader />;
  const member = me.data?.memberships.some((m) => m.organizationId === orgId);
  if (!member && !me.data?.isPlatformAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  if (!isConfigured) return <NotConfiguredPage />;
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Suspense fallback={<FullscreenLoader />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/recuperar" element={<RecoverPage />} />
                <Route path="/nueva-contrasena" element={<ResetPasswordPage />} />
                <Route path="/auth/callback" element={<ResetPasswordPage />} />
                <Route path="/mfa" element={<MfaPage />} />
                <Route
                  path="/"
                  element={
                    <RequireAuth>
                      <HomeRedirect />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <RequireAuth>
                      <AdminPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/cuenta"
                  element={
                    <RequireAuth>
                      <AccountPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="/o/:orgId"
                  element={
                    <RequireAuth>
                      <OrgGuard>
                        <AppShell />
                      </OrgGuard>
                    </RequireAuth>
                  }
                >
                  <Route index element={<DashboardPage />} />
                  <Route path="clientes" element={<ClientsPage />} />
                  <Route path="clientes/:clientId" element={<ClientDetailPage />} />
                  <Route path="usuarios" element={<MembersPage />} />
                  <Route path="auditoria" element={<AuditPage />} />
                  <Route path="ajustes" element={<SettingsPage />} />
                  <Route path="bandeja" element={<InboxPage />} />
                  <Route path="bandeja/:interactionId" element={<InteractionPage />} />
                  <Route path="aprobaciones" element={<ApprovalsPage />} />
                  <Route
                    path="alertas"
                    element={
                      <ComingSoonPage
                        title="Alertas"
                        phase="Fase 5"
                        description="Avisos de reseñas negativas, comentarios graves, fallos de sincronización y publicaciones."
                      />
                    }
                  />
                  <Route
                    path="informes"
                    element={
                      <ComingSoonPage
                        title="Informes"
                        phase="Fase 5"
                        description="Métricas observadas, evolución y resúmenes generados con IA, claramente diferenciados."
                      />
                    }
                  />
                  <Route path="fuentes" element={<SourcesPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
