import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

interface AuthState {
  session: Session | null;
  loading: boolean;
  /** true si el usuario tiene MFA configurado y la sesión aún no lo ha verificado. */
  needsMfa: boolean;
  refreshAal: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsMfa, setNeedsMfa] = useState(false);
  const qc = useQueryClient();

  const refreshAal = async () => {
    if (!supabase) return;
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setNeedsMfa(data?.nextLevel === 'aal2' && data.currentLevel !== 'aal2');
  };

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await refreshAal();
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) qc.clear();
      void refreshAal();
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const signOut = async () => {
    await supabase?.auth.signOut();
    qc.clear();
  };

  return (
    <AuthCtx.Provider value={{ session, loading, needsMfa, refreshAal, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth fuera de AuthProvider');
  return v;
}

export function useMe() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['me', session?.user.id],
    queryFn: () => api<Me>('/me'),
    enabled: Boolean(session),
    staleTime: 60_000,
  });
}
