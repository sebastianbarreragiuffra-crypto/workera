"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordMfaEvent } from "@/lib/admin/mfa-audit";
import { getMfaAccountState } from "@/lib/auth/mfa-account";
import { createClient } from "@/lib/supabase/server";
import { normalizeMfaQrCodeDataUri } from "./qr-code";

/**
 * Inscripción de un segundo factor TOTP (sección 6.1 del diseño).
 *
 * El QR y el secreto viajan al navegador porque no hay otra forma de que la
 * persona los copie a su aplicación de autenticación; por eso la pantalla los
 * muestra una sola vez, mientras dura la inscripción, y nunca se guardan en
 * esta aplicación ni se registran en la bitácora ni en el log.
 */

export interface MfaEnrollment {
  factorId: string;
  /** SVG del QR, ya como data URI listo para `<img src>`. */
  qrCodeDataUri: string;
  /** Mismo secreto que codifica el QR, para entrada manual. */
  secret: string;
}

export interface MfaEnrollmentState {
  status: "idle" | "enrolling" | "error" | "done";
  message: string;
  /** Solo la acción inicial lo devuelve; el navegador nunca lo reenvía. */
  enrollment: MfaEnrollment | null;
}

/**
 * El desfase de reloj del teléfono es la causa número uno de un TOTP que "no
 * funciona". Decirlo en el mensaje evita el diagnóstico equivocado de que el
 * QR se escaneó mal.
 */
const INVALID_CODE_MESSAGE =
  "El código no es válido. Si acabás de inscribir, revisá que la hora de tu teléfono esté en automático.";

const friendlyNameInput = z.object({
  friendlyName: z.string().trim().min(2).max(40),
});
const confirmInput = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});
const factorInput = z.object({
  factorId: z.string().uuid(),
});

function entries(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

function error(message: string): MfaEnrollmentState {
  return { status: "error", message, enrollment: null };
}

const CHALLENGE_FIRST_MESSAGE =
  "Verifica el segundo factor que ya tienes antes de cambiar esta configuración.";

type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * ¿Esta sesión debe probar el factor que ya existe antes de tocar la
 * configuración de segundo factor?
 *
 * Quien ya tiene un factor verificado y llega en `aal1` presentó solo una
 * contraseña. Dejarla inscribir otro dispositivo o dar de baja el actual sería
 * el bypass completo del segundo factor: se descarta el factor de la persona,
 * se inscribe el propio y la sesión sube a `aal2` sin haber probado nada.
 *
 * La pantalla ya evita ofrecer esos botones en `aal1` -- muestra el desafío --,
 * pero una Server Action es un endpoint y ocultar el botón no la protege.
 * Supabase Auth también rechaza ambas operaciones en `aal1`; esta guarda existe
 * para que la propiedad no dependa de que ese comportamiento del proveedor se
 * mantenga, y para que se pueda probar acá.
 */
async function mustChallengeBeforeChangingFactors(supabase: SessionClient): Promise<boolean> {
  const [{ data: aal }, { data: factors }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);

  // Fail-closed: sin poder leer el nivel o los factores se asume que hay algo
  // que proteger. El costo de equivocarse hacia este lado es un desafío de más.
  if (!aal || !factors) return true;
  if (aal.currentLevel === "aal2") return false;
  return (factors.totp ?? []).length > 0;
}

/**
 * Paso 1: crea un factor sin verificar y devuelve su QR y su secreto.
 *
 * Un factor recién inscrito queda `unverified` y NO cuenta como segundo
 * factor: mientras no se confirme con un código, la cuenta sigue exactamente
 * igual de expuesta que antes.
 */
export async function startMfaEnrollmentAction(
  formData: FormData
): Promise<MfaEnrollmentState> {
  const supabase = await createClient();
  const account = await getMfaAccountState(supabase);
  if (!account) return error("Tu sesión expiró. Vuelve a iniciar sesión.");

  if (await mustChallengeBeforeChangingFactors(supabase)) {
    return error(CHALLENGE_FIRST_MESSAGE);
  }

  const parsed = friendlyNameInput.safeParse(entries(formData));
  if (!parsed.success) {
    return error("Ponle un nombre de entre 2 y 40 caracteres para reconocer este dispositivo.");
  }

  const { data, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: parsed.data.friendlyName,
  });

  if (enrollError || !data) {
    // El caso frecuente es un nombre repetido: Supabase exige que el nombre
    // sea único por cuenta. No se propaga el mensaje del proveedor.
    return error(
      "No pudimos iniciar la inscripción. Si ya tienes un dispositivo con ese nombre, usa otro."
    );
  }

  let qrCodeDataUri: string;
  try {
    qrCodeDataUri = normalizeMfaQrCodeDataUri(data.totp.qr_code);
  } catch {
    const { error: cleanupError } = await supabase.auth.mfa.unenroll({ factorId: data.id });
    if (cleanupError) {
      console.error("[auth] no se pudo limpiar una inscripción MFA inválida", {
        event: "mfa_invalid_enrollment_cleanup_failed",
      });
      return error("No pudimos generar un código QR seguro. Actualiza la página y descarta el intento incompleto.");
    }
    return error("No pudimos generar un código QR seguro. Vuelve a probar.");
  }

  return {
    status: "enrolling",
    message: "",
    enrollment: {
      factorId: data.id,
      // auth-js ya antepone el data URI al SVG; volver a codificarlo rompe la
      // imagen porque también transforma el propio prefijo.
      qrCodeDataUri,
      secret: data.totp.secret,
    },
  };
}

/**
 * Paso 2: confirma el factor con el primer código de la aplicación.
 *
 * `factorId` llega desde el cliente y se trata como no confiable: la
 * pertenencia real la comprueba Supabase Auth, que solo verifica factores de
 * la sesión que hace la llamada. Un id ajeno falla ahí, no acá.
 */
export async function confirmMfaEnrollmentAction(
  formData: FormData
): Promise<MfaEnrollmentState> {
  const supabase = await createClient();
  const account = await getMfaAccountState(supabase);
  if (!account) return error("Tu sesión expiró. Vuelve a iniciar sesión.");

  const parsed = confirmInput.merge(factorInput).safeParse(entries(formData));
  if (!parsed.success) return error("El código son 6 dígitos, sin espacios.");

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: parsed.data.factorId,
  });
  if (challengeError || !challenge) {
    return error("No pudimos verificar el código en este momento. Intenta otra vez.");
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: parsed.data.factorId,
    challengeId: challenge.id,
    code: parsed.data.code,
  });
  if (verifyError) {
    return error(INVALID_CODE_MESSAGE);
  }

  const recorded = await recordMfaEvent({
    userId: account.userId,
    eventType: "ENROLLED",
    factorId: parsed.data.factorId,
  });

  revalidatePath("/seguridad/mfa");

  return {
    status: "done",
    message: recorded
      ? "Listo. Este dispositivo ya es tu segundo factor."
      : "Listo. Este dispositivo ya es tu segundo factor, pero no pudimos registrar el evento en la bitácora.",
    enrollment: null,
  };
}

/**
 * Descarta un factor. Sirve para el factor a medio inscribir que quedó
 * `unverified` tras un intento fallido, y para dar de baja un dispositivo que
 * ya no se usa.
 */
export async function discardMfaFactorAction(
  formData: FormData
): Promise<MfaEnrollmentState> {
  const supabase = await createClient();
  const account = await getMfaAccountState(supabase);
  if (!account) return error("Tu sesión expiró. Vuelve a iniciar sesión.");

  if (await mustChallengeBeforeChangingFactors(supabase)) {
    return error(CHALLENGE_FIRST_MESSAGE);
  }

  const parsed = factorInput.safeParse(entries(formData));
  if (!parsed.success) return error("No reconocimos ese dispositivo.");

  const { error: unenrollError } = await supabase.auth.mfa.unenroll({
    factorId: parsed.data.factorId,
  });
  if (unenrollError) {
    return error("No pudimos quitar ese dispositivo. Intenta otra vez.");
  }

  await recordMfaEvent({
    userId: account.userId,
    eventType: "UNENROLLED",
    factorId: parsed.data.factorId,
  });

  revalidatePath("/seguridad/mfa");

  return { status: "done", message: "Dispositivo dado de baja.", enrollment: null };
}
