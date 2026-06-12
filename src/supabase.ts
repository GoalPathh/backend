import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
export const supabaseAuth = createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
