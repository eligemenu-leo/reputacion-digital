import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, isConfigured } from './env';

/**
 * El frontend usa Supabase SOLO para autenticación. Los datos de negocio se
 * leen y escriben a través de la API propia (autorización en servidor + RLS).
 */
export const supabase: SupabaseClient | null = isConfigured
  ? createClient(env.supabaseUrl!, env.supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;
