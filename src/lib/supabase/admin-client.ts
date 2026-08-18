import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Cliente Supabase con `SUPABASE_SERVICE_ROLE_KEY` — bypassea RLS por
 * diseño. `import "server-only"` hace que Next.js falle el build si algún
 * Client Component intentara importar este módulo.
 *
 * Reservado EXCLUSIVAMENTE para operaciones que requieren la API de
 * administración de Supabase Auth (`auth.admin.*`, ej. crear una cuenta
 * humana) — inalcanzable con la clave `anon`/RLS normal (Fase 5D, PASO 9/10
 * del encargo: "Cualquier operación administrativa Supabase Auth que
 * requiera service role debe ser SERVER-ONLY").
 *
 * Este cliente NUNCA decide autorización por sí mismo — ver
 * `src/lib/admin/user-management.ts`, donde cada función primero valida el
 * rol del llamador contra su SESIÓN real (sujeta a RLS) antes de usar este
 * cliente para la única parte que la sesión normal no puede hacer.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "createAdminClient() requiere NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY configurados."
    );
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
