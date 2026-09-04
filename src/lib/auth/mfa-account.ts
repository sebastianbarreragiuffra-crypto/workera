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

export interface MfaAccountState {
  userId: string;
  /** Espejo de `account_requires_mfa`; la autoridad sigue siendo la base. */
  requiresMfa: boolean;
  /** Permite recomendar un autenticador de respaldo al OWNER de plataforma. */
  isPlatformOwner: boolean;
}

/**
 * No se pudo determinar de forma confiable el estado MFA de la identidad.
 * Las operaciones privilegiadas deben tratar este caso como bloqueo, nunca
 * como "esta cuenta no exige MFA".
 */
export class MfaStateUnavailableError extends Error {
  constructor() {
    super("No pudimos verificar el estado de seguridad de tu cuenta.");
    this.name = "MfaStateUnavailableError";
  }
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

  if (profileResult.error || membershipResult.error || !profileResult.data) {
    throw new MfaStateUnavailableError();
  }

  const profile = {
    role: profileResult.data.role as AppRole | null,
    active: profileResult.data.active,
  };
  const platformMembership = membershipResult.data
    ? { role: membershipResult.data.role as PlatformRole, active: membershipResult.data.active }
    : null;

  return {
    userId,
    requiresMfa: profileRequiresMfa({ profile, platformMembership }),
    isPlatformOwner:
      profile.active && platformMembership?.role === "OWNER" && platformMembership.active,
  };
}

/**
 * A dónde mandar una sesión recién creada por contraseña.
 *
 * `nextLevel` llega en `aal2` exactamente cuando la cuenta tiene al menos un
 * factor verificado, así que no hace falta listar factores para saberlo: es el
 * mismo dato, y evita una llamada de red en cada login.
 *
 * `MFA_ENFORCEMENT_ENABLED` gobierna la OBLIGACIÓN de inscribirse, no el
 * desafío de quien ya se inscribió. Las dos mitades se comportan distinto a
 * propósito:
 *
 *   - Con el flag apagado, una cuenta privilegiada que todavía no inscribió
 *     nada entra directo. El paso 1 del rollout queda así completamente
 *     invisible: nadie ve una pantalla nueva antes de que se le avise.
 *   - El desafío de quien SÍ tiene un factor verificado no depende del flag.
 *     Esa persona se inscribió a propósito, y pedirle el código es lo que
 *     permite comprobar que el flujo completo funciona antes de encender el
 *     bloqueo. Saltárselo dejaría su segundo factor sin efecto justo en los
 *     días en que hay que verificar que quedó bien.
 */
export async function resolvePostLoginDestination(
  supabase: SupabaseClient<Database>
): Promise<PostLoginDestination> {
  const [aalResult, account] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    getMfaAccountState(supabase),
  ]);

  if (aalResult.error || !account) {
    throw new MfaStateUnavailableError();
  }

  const currentLevel = aalResult.data?.currentLevel ?? null;
  const nextLevel = aalResult.data?.nextLevel ?? null;

  return postLoginDestination({
    currentLevel,
    nextLevel,
    requiresMfa: isMfaEnforcementEnabled() && (account?.requiresMfa ?? false),
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
  if (!account) throw new MfaRequiredError("No pudimos verificar tu sesión de seguridad.");
  if (!account.requiresMfa) return;

  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || data?.currentLevel !== "aal2") {
    throw new MfaRequiredError(
      "Esta operación requiere verificación de segundo factor (MFA)."
    );
  }
}
