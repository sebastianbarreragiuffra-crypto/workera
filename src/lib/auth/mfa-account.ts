import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { isMfaEnforcementEnabled } from "../supabase/middleware";
import {
  postLoginDestination,
  profileRequiresMfa,
  type AppRole,
  type PlatformRole,
  type PostLoginDestination,
} from "./mfa";

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

/**
 * A dónde mandar una sesión recién creada por contraseña.
 *
 * `nextLevel` llega en `aal2` exactamente cuando la cuenta tiene al menos un
 * factor verificado, así que no hace falta listar factores para saberlo: es el
 * mismo dato, y evita una llamada de red en cada login.
 */
export async function resolvePostLoginDestination(
  supabase: SupabaseClient<Database>
): Promise<PostLoginDestination> {
  const [aalResult, account] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    getMfaAccountState(supabase),
  ]);

  const currentLevel = aalResult.data?.currentLevel ?? null;
  const nextLevel = aalResult.data?.nextLevel ?? null;

  return postLoginDestination({
    currentLevel,
    nextLevel,
    requiresMfa: account?.requiresMfa ?? false,
    hasVerifiedFactor: nextLevel === "aal2",
  });
}

/** Se lanza cuando una operación sensible se pide sin segundo factor. */
export class MfaRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaRequiredError";
  }
}

/**
 * Equivalente en la aplicación de `enforce_mfa_for_privileged()`, para las
 * operaciones sensibles que NO pasan por un RPC y por lo tanto no tienen dónde
 * apoyarse en la base. Hoy: la generación de lotes de nómina (sección 7 del
 * diseño).
 *
 * A diferencia de la guarda SQL, esta respeta `MFA_ENFORCEMENT_ENABLED`. No es
 * una excepción al bloqueo inmediato: es lo que mantiene coherente el
 * despliegue en dos pasos. Las dos capas que corren en la aplicación se
 * encienden con el mismo interruptor y en el mismo momento; la de base de
 * datos, que no puede leer variables de entorno, se enciende al aplicar su
 * migración, que por eso va en el paso 5 del rollout.
 *
 * Igual que la versión SQL, deja pasar a quien no exige MFA: es segura de
 * agregar a cualquier operación sin cambiar el comportamiento de nadie más.
 */
export async function assertSecondFactorForPrivileged(
  supabase: SupabaseClient<Database>
): Promise<void> {
  if (!isMfaEnforcementEnabled()) return;

  const account = await getMfaAccountState(supabase);
  if (!account?.requiresMfa) return;

  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (data?.currentLevel !== "aal2") {
    throw new MfaRequiredError(
      "Esta operación requiere verificación de segundo factor (MFA)."
    );
  }
}
