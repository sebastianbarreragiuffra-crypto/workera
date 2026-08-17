import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

/**
 * Cliente Supabase para Server Components / Route Handlers, ligado a la
 * sesión del usuario mediante cookies. Sigue respetando RLS como el usuario
 * autenticado — NO es un cliente con privilegios elevados.
 *
 * Para operaciones que legítimamente requieren `service_role` (ej. la futura
 * sincronización con Workera), ese cliente se crea por separado, solo en
 * código server-side que nunca se envía al navegador, y nunca a partir de
 * este helper. Ver docs/SECURITY_PHASE3.md sección "service_role boundaries".
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll fue llamado desde un Server Component sin permiso de
            // escritura de cookies — se ignora porque el middleware ya
            // refresca la sesión en cada request (patrón oficial de
            // @supabase/ssr).
          }
        },
      },
    }
  );
}
