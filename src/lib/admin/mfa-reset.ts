import "server-only";

import { createAdminClient } from "../supabase/admin-client";
import { createClient } from "../supabase/server";
import { getMfaAccountState } from "../auth/mfa-account";
import { recordMfaEvent } from "./mfa-audit";

/**
 * Reseteo del segundo factor de OTRA persona (sección 6.3 del diseño).
 *
 * Vive en `src/lib/admin/` y no junto al resto del MFA porque es uno de los
 * límites que usan `service_role`, y esa allowlist es por directorio: meterlo
 * en `src/lib/auth/` habría obligado a abrir ahí el cliente admin, y en ese
 * directorio también viven módulos puros que no deben poder alcanzarlo.
 *
 * La autorización vive en `can_reset_mfa_for()`, no acá: solo el OWNER de
 * plataforma puede resetear a otra persona. Un factor pertenece a la identidad
 * global de Auth, así que permitirlo a un administrador tenant afectaría
 * también los accesos de esa persona a otras empresas. La propia cuenta OWNER
 * se recupera únicamente mediante el break-glass del runbook.
 *
 * Este módulo usa el cliente `service_role` para una sola cosa: la API de
 * administración de Supabase Auth, que es lo único que una sesión normal no
 * puede hacer. La autorización la decide siempre la sesión real, igual que en
 * `admin/user-management.ts`.
 */

export class MfaResetAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaResetAuthorizationError";
  }
}

export class MfaResetFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaResetFailedError";
  }
}

export interface MfaResetResult {
  removedFactors: number;
  /** Si el evento quedó en la bitácora. Un reseteo sin registro es un problema. */
  eventRecorded: boolean;
}

export async function resetUserMfa(targetUserId: string): Promise<MfaResetResult> {
  const supabase = await createClient();

  const account = await getMfaAccountState(supabase);
  if (!account) {
    throw new MfaResetAuthorizationError("Tu sesión expiró. Vuelve a iniciar sesión.");
  }

  // El llamador tiene que haber probado SU propio segundo factor. Reiniciar el
  // de otra persona es justo la operación que no debe quedar al alcance de una
  // sesión que solo presentó una contraseña. Esta comprobación no depende de
  // `MFA_ENFORCEMENT_ENABLED`: no es el bloqueo general, es un requisito de
  // esta operación en particular.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    throw new MfaResetAuthorizationError(
      "Verifica tu propio segundo factor antes de reiniciar el de otra persona."
    );
  }

  // La autoridad es la base. Se consulta con el cliente de sesión, así que
  // `auth.uid()` dentro de la función es el llamador real y no el service_role.
  const { data: allowed, error: authorizationError } = await supabase.rpc("can_reset_mfa_for", {
    p_target: targetUserId,
  });
  if (authorizationError || allowed !== true) {
    throw new MfaResetAuthorizationError(
      "No tienes permiso para reiniciar el segundo factor de esa persona."
    );
  }

  const admin = createAdminClient();
  const { data: factorData, error: listError } = await admin.auth.admin.mfa.listFactors({
    userId: targetUserId,
  });
  if (listError) {
    throw new MfaResetFailedError("No pudimos leer los factores de esa persona.");
  }

  // Debe existir evidencia ANTES de la primera mutación externa. La API de
  // Auth no ofrece una transacción que abarque varios factores; si la segunda
  // eliminación falla, este evento prueba que hubo un intento administrativo.
  const startedRecorded = await recordMfaEvent({
    userId: targetUserId,
    eventType: "ADMIN_RESET_STARTED",
    performedBy: account.userId,
  });
  if (!startedRecorded) {
    throw new MfaResetFailedError(
      "No pudimos abrir la bitácora del reinicio. No se modificó ningún factor."
    );
  }

  let removedFactors = 0;
  for (const factor of factorData?.factors ?? []) {
    const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({
      id: factor.id,
      userId: targetUserId,
    });
    if (deleteError) {
      await recordMfaEvent({
        userId: targetUserId,
        eventType: removedFactors > 0 ? "ADMIN_RESET_PARTIAL" : "ADMIN_RESET_FAILED",
        performedBy: account.userId,
      });
      throw new MfaResetFailedError(
        `Se quitaron ${removedFactors} de ${factorData?.factors.length ?? 0} factores. Vuelve a intentarlo.`
      );
    }
    removedFactors += 1;
  }

  const eventRecorded = await recordMfaEvent({
    userId: targetUserId,
    eventType: "ADMIN_RESET",
    performedBy: account.userId,
  });

  return { removedFactors, eventRecorded };
}
