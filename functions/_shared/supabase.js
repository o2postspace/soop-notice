import { createClient } from "@supabase/supabase-js";

export function createSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}
