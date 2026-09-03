import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { profileRequiresMfa, type AppRole, type PlatformRole } from "./mfa";

/** Los cinco eventos que la bitácora acepta (ver la migración de la etapa A). */
export type MfaEventType =
  | "ENROLLED"
  | "VERIFY_SUCCESS"
  | "VERIFY_FAILURE"
  | "UNENROLLED"
  | "ADMIN_RESET";

export interface MfaAccountState {
  userId: string;
  /** Espejo de `account_requires_mfa`; la autoridad sigue siendo la base. */
  requiresMfa: boolean;
  /**
   * El OWNER de plataforma necesita DOS factores TOTP: Supabase Auth no tiene
   * códigos de recuperación de un solo uso, así que el segundo factor guardado
   * fuera del teléfono es su única forma de volver a entrar sin pasar por el
   * break-glass del panel de Supabase.
   */
  isPlatformOwner: boolean;
}

/**
 * Estado de segundo factor de la sesión actual, leído con el cliente ligado a
 * cookies y por lo tanto sujeto a RLS: una cuenta solo ve su propio profile y
 * su propia membresía de plataforma.
 */
export async function getMfaAccountState(
  supabase: SupabaseClient<Database>
): Promise<MfaAccountState | null> {
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;

  if (claimsError || typeof userId !== "string" || userId.length === 0) {
    return null;
  }

  const [profileResult, membershipResult] = await Promise.all([
    supabase.from("profiles").select("role, active").eq("id", userId).maybeSingle(),
    supabase
      .from("platform_memberships")
      .select("role, active")
      .eq("user_id", userId)
      .eq("active", true)
      .maybeSingle(),
  ]);

  const profile = profileResult.data
    ? { role: profileResult.data.role as AppRole | null, active: profileResult.data.active }
    : null;
  const platformMembership = membershipResult.data
    ? { role: membershipResult.data.role as PlatformRole, active: membershipResult.data.active }
    : null;

  return {
    userId,
    requiresMfa: profileRequiresMfa({ profile, platformMembership }),
    isPlatformOwner: platformMembership?.role === "OWNER" && platformMembership.active,
  };
}

export interface MfaEventInput {
  userId: string;
  eventType: MfaEventType;
  factorId?: string | null;
  /** Solo para ADMIN_RESET: quién ejecutó el reseteo de otra persona. */
  performedBy?: string | null;
}

/**
 * Registra un evento en la bitácora con el cliente de sesión, no con
 * `service_role`: la misma policy que autoriza la operación autoriza su
 * registro, así que un intento de registrar un evento ajeno se rechaza en la
 * base y no solo acá.
 *
 * No lanza. Cuando esto se llama, el factor ya fue verificado o borrado en
 * Supabase Auth: hacer fallar la pantalla dejaría a la persona con un segundo
 * factor que sí funciona y un error que no puede resolver. Devuelve si pudo
 * registrar para que el llamador lo refleje, y deja el fallo en el log del
 * servidor sin identificadores ni mensajes del proveedor.
 */
export async function recordMfaEvent(
  supabase: SupabaseClient<Database>,
  input: MfaEventInput
): Promise<boolean> {
  const { error } = await supabase.from("mfa_events").insert({
    user_id: input.userId,
    event_type: input.eventType,
    factor_id: input.factorId ?? null,
    performed_by: input.performedBy ?? null,
  });

  if (error) {
    console.error("[mfa] no se pudo registrar el evento de segundo factor", {
      event: "mfa_event_insert_failed",
      eventType: input.eventType,
    });
    return false;
  }

  return true;
}
