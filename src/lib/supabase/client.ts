import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * Cliente Supabase para Client Components. Usa únicamente las claves
 * públicas (NEXT_PUBLIC_*) — respeta RLS como cualquier usuario autenticado
 * o anónimo. Nunca importar aquí SUPABASE_SERVICE_ROLE_KEY.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
