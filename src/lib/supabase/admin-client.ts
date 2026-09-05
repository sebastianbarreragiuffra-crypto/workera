import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import {
  assertServiceRoleCapability,
  type ServiceRoleCapability,
} from "./service-role-capabilities";

/**
 * Cliente Supabase con `SUPABASE_SERVICE_ROLE_KEY` — bypassea RLS por
 * diseño. `import "server-only"` hace que Next.js falle el build si algún
 * Client Component intentara importar este módulo.
 *
 * Reservado para las capacidades cerradas de
 * `service-role-capabilities.ts`: administración de Auth y procesos internos
 * que no pueden operar con la sesión humana ni con acceso directo desde el
 * navegador. El identificador obligatorio deja cada consumidor inventariado.
 *
 * Este cliente NUNCA decide autorización por sí mismo. La sesión, firma de
 * webhook o secreto de job se valida antes, y las mutaciones tenant vuelven a
 * comprobar actor/empresa dentro de RPC específicas.
 */
export function createAdminClient(capability: ServiceRoleCapability) {
  assertServiceRoleCapability(capability);
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
