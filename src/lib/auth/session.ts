import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];

/**
 * Usuario autenticado + su profile (rol incluido), leído server-side
 * respetando RLS (un usuario solo puede leer su propio profile, salvo que
 * sea ADMIN_RRHH — ver migración 14). Devuelve null si no hay sesión.
 *
 * No usar el resultado de esta función como la única barrera de
 * autorización de una operación de escritura: siempre debe existir además
 * una policy RLS en la tabla correspondiente (UI != seguridad, ver
 * docs/SECURITY_PHASE3.md).
 */
export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return profile;
}
