"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { recordMfaEvent } from "@/lib/admin/mfa-audit";
import { getMfaAccountState } from "@/lib/auth/mfa-account";
import { createClient } from "@/lib/supabase/server";

/**
 * Desafío de segundo factor (sección 6.2 del diseño).
 *
 * La acción vive acá pero la usan DOS pantallas: `/login/mfa`, a donde llega
 * quien acaba de autenticarse con contraseña, y `/seguridad/mfa`, a donde el
 * gate del middleware manda a cualquier sesión privilegiada que siga en aal1.
 * Son la misma operación y no deben poder divergir.
 */

export interface MfaChallengeState {
  status: "idle" | "error";
  message: string;
}

const INVALID_CODE_MESSAGE =
  "El código no es válido. Revisá que la hora de tu teléfono esté en automático y probá con el código actual.";

const challengeInput = z.object({
  factorId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/),
});

export async function verifyMfaChallengeAction(
  _prevState: MfaChallengeState,
  formData: FormData
): Promise<MfaChallengeState> {
  const supabase = await createClient();
  const account = await getMfaAccountState(supabase);
  if (!account) redirect("/login");

  const parsed = challengeInput.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { status: "error", message: "El código son 6 dígitos, sin espacios." };
  }

  // `factorId` llega del navegador y se valida solo en su forma. La
  // pertenencia real la comprueba Supabase Auth, que únicamente resuelve
  // factores de la sesión que hace la llamada: un id ajeno falla ahí.
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: parsed.data.factorId,
    code: parsed.data.code,
  });

  if (error) {
    // Supabase ya limita la tasa de verificación. Registrar el fallo es lo que
    // convierte un intento de fuerza bruta en una señal visible.
    await recordMfaEvent({
      userId: account.userId,
      eventType: "VERIFY_FAILURE",
      factorId: parsed.data.factorId,
    });
    return { status: "error", message: INVALID_CODE_MESSAGE };
  }

  await recordMfaEvent({
    userId: account.userId,
    eventType: "VERIFY_SUCCESS",
    factorId: parsed.data.factorId,
  });

  revalidatePath("/", "layout");
  redirect("/");
}
