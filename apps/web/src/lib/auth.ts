import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './types';
let client: SupabaseClient | null = null;
export function auth(config: Config): SupabaseClient | null {
  if (config.authMode !== 'supabase') return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseKey, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });
  return client;
}
