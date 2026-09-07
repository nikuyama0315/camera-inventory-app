import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が設定されていません。.env を確認してください。",
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
