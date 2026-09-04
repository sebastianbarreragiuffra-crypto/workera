import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../supabase/admin-client";
import type { Database } from "../supabase/database.types";

export type MfaEventType =
  | "ENROLLED"
  | "VERIFY_SUCCESS"
  | "VERIFY_FAILURE"
  | "UNENROLLED"
  | "ADMIN_RESET_STARTED"
  | "ADMIN_RESET"
  | "ADMIN_RESET_PARTIAL"
  | "ADMIN_RESET_FAILED";

export interface MfaEventInput {
  userId: string;
  eventType: MfaEventType;
  factorId?: string | null;
  /** Obligatorio por constraint para cualquier evento administrativo. */
  performedBy?: string | null;
}

interface MfaAuditDependencies {
  supabaseAdmin?: SupabaseClient<Database>;
}

/**
 * Escribe evidencia MFA desde el único límite server-only autorizado a usar
 * service_role. `authenticated` no tiene INSERT sobre `mfa_events`, así que
 * el navegador no puede fabricar verificaciones ni llenar la bitácora.
 *
 * No lanza: algunos llamadores registran el resultado después de que Auth ya
 * cambió. Devuelve false para que el flujo muestre una advertencia o, en el
 * caso de un reseteo administrativo, aborte antes de borrar el primer factor.
 */
export async function recordMfaEvent(
  input: MfaEventInput,
  dependencies: MfaAuditDependencies = {}
): Promise<boolean> {
  const supabaseAdmin = dependencies.supabaseAdmin ?? createAdminClient();
  const { error } = await supabaseAdmin.from("mfa_events").insert({
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
