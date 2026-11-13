export const env = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787',
};

export const isConfigured = Boolean(env.supabaseUrl && env.supabaseAnonKey);
