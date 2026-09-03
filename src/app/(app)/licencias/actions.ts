"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { requireMedicalLicenseApprover } from "../../../lib/supabase/authorize";
import { assertEmployeeAccessAllowed, type CallerRole } from "../../../lib/access/scope";
import { uploadMedicalLicense, approveMedicalLicense, rejectMedicalLicense, MAX_MEDICAL_LICENSE_DAYS } from "../../../lib/decisions/medical-license";
import { extractMedicalLicenseDates } from "../../../lib/decisions/medical-license-extraction";
import { todayInSantiago, isCalendarDate } from "../../../lib/view-models/date-utils";

/**
 * Server Actions de Licencias. Cada una usa el cliente de SESIÓN (nunca
 * admin) -- RLS sigue siendo el enforcement real; los chequeos acá son una
 * segunda capa con mensaje claro, nunca la única barrera.
 */

async function requireAuthenticatedProfile() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  return { ...profile, role: profile.role as CallerRole };
}

export interface UploadMedicalLicenseActionState {
  status: "idle" | "success" | "error";
  message: string;
  extractionStatus: "EXTRAIDO" | "REQUIERE_REVISION" | null;
}

/**
 * Ya no pide fecha de inicio/término manuales -- el documento subido es la
 * fuente de esas fechas (`extractMedicalLicenseDates`, reutilizada tal cual,
 * sin segundo sistema de extracción). Si el documento no se puede
 * interpretar con confianza, la licencia queda marcada REQUIERE_REVISION con
 * un placeholder de un solo día (hoy) -- nunca se inventa un rango -- y el
 * aprobador corrige las fechas en el paso de aprobación (ya existente:
 * `ApprovalPanel` deja editar el rango propuesto antes de confirmar).
 * Subir NUNCA marca "L" -- eso sigue dependiendo exclusivamente de
 * `approveMedicalLicenseAction`.
 */
export async function uploadMedicalLicenseAction(_prev: UploadMedicalLicenseActionState, formData: FormData): Promise<UploadMedicalLicenseActionState> {
  const profile = await requireAuthenticatedProfile();
  const supabase = await createClient();

  const employeeId = formData.get("employeeId") as string | null;
  const file = formData.get("file") as File | null;

  if (!employeeId) {
    return { status: "error", message: "Selecciona el trabajador.", extractionStatus: null };
  }
  if (!file || file.size === 0) {
    return { status: "error", message: "Adjunta el documento de la licencia médica.", extractionStatus: null };
  }

  try {
    // Nunca confiar en que el cliente esté autorizado para este empleado -- mismo criterio
    // ya usado en revision-diaria/empleados/[id] para cualquier acción que reciba un employeeId.
    await assertEmployeeAccessAllowed(supabase, profile.role, employeeId);
  } catch {
    return { status: "error", message: "No tienes acceso a este trabajador.", extractionStatus: null };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const extraction = extractMedicalLicenseDates(fileBytes);
  const today = todayInSantiago();
  const proposedStartDate = extraction.proposedStartDate ?? today;
  const proposedEndDate = extraction.proposedEndDate ?? today;

  try {
    await uploadMedicalLicense(supabase, {
      employeeId,
      proposedStartDate,
      proposedEndDate,
      extractionStatus: extraction.status,
      originalFilename: file.name,
      mimeType: file.type || "application/octet-stream",
      fileBytes,
      uploadedBy: profile.id,
    });
  } catch (err) {
    // El mensaje interno arrastra el error crudo de PostgREST/Storage. Estos
    // son datos de salud: el detalle queda en el log del servidor, nunca en la
    // respuesta.
    console.error("[licencias] fallo subiendo la licencia", err instanceof Error ? err.message : "error desconocido");
    return { status: "error", message: "No pudimos subir la licencia.", extractionStatus: null };
  }

  revalidatePath("/licencias");
  const message =
    extraction.status === "EXTRAIDO"
      ? "Licencia subida -- fechas detectadas en el documento, queda pendiente de aprobación de RRHH."
      : "Licencia subida -- no se pudieron leer las fechas del documento con confianza, queda pendiente de revisión y aprobación de RRHH.";
  return { status: "success", message, extractionStatus: extraction.status };
}

export interface ApproveMedicalLicenseActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export async function approveMedicalLicenseAction(_prev: ApproveMedicalLicenseActionState, formData: FormData): Promise<ApproveMedicalLicenseActionState> {
  try {
    await requireMedicalLicenseApprover();
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No autorizado." };
  }

  const supabase = await createClient();
  const approvalId = formData.get("approvalId") as string | null;
  const confirmedStartDate = formData.get("confirmedStartDate") as string | null;
  const confirmedEndDate = formData.get("confirmedEndDate") as string | null;

  if (!approvalId || !confirmedStartDate || !confirmedEndDate) {
    return { status: "error", message: "Faltan datos para confirmar la aprobación." };
  }
  if (!isCalendarDate(confirmedStartDate) || !isCalendarDate(confirmedEndDate)) {
    return { status: "error", message: "Las fechas confirmadas deben ser días reales en formato YYYY-MM-DD." };
  }
  if (confirmedEndDate < confirmedStartDate) {
    return { status: "error", message: "La fecha de término no puede ser anterior a la fecha de inicio." };
  }
  // Aprobar escribe una fila de asistencia por cada día del rango. El panel
  // deja editar el rango propuesto, así que un año mal tecleado bastaba para
  // pedir siglos de escrituras. La base también lo rechaza; esto solo llega
  // antes y con un mensaje entendible.
  const spanDays = Math.round((Date.parse(`${confirmedEndDate}T00:00:00Z`) - Date.parse(`${confirmedStartDate}T00:00:00Z`)) / 86_400_000) + 1;
  if (spanDays > MAX_MEDICAL_LICENSE_DAYS) {
    return {
      status: "error",
      message: `El rango confirmado (${spanDays} días) supera el máximo de ${MAX_MEDICAL_LICENSE_DAYS} días. Revisa las fechas.`,
    };
  }

  try {
    await approveMedicalLicense(supabase, { approvalId, confirmedStartDate, confirmedEndDate });
  } catch (err) {
    console.error("[licencias] fallo aprobando la licencia", err instanceof Error ? err.message : "error desconocido");
    return { status: "error", message: "No pudimos aprobar la licencia." };
  }

  revalidatePath("/licencias");
  return { status: "success", message: "Licencia aprobada -- se generó \"L\" en asistencia para el período confirmado." };
}

export interface RejectMedicalLicenseActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export async function rejectMedicalLicenseAction(_prev: RejectMedicalLicenseActionState, formData: FormData): Promise<RejectMedicalLicenseActionState> {
  try {
    await requireMedicalLicenseApprover();
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No autorizado." };
  }

  const supabase = await createClient();
  const approvalId = formData.get("approvalId") as string | null;
  const reason = (formData.get("reason") as string | null)?.trim();

  if (!approvalId) {
    return { status: "error", message: "Falta identificar la licencia a rechazar." };
  }
  if (!reason) {
    return { status: "error", message: "El motivo del rechazo es obligatorio." };
  }

  try {
    await rejectMedicalLicense(supabase, { approvalId, reason });
  } catch (err) {
    console.error("[licencias] fallo rechazando la licencia", err instanceof Error ? err.message : "error desconocido");
    return { status: "error", message: "No pudimos rechazar la licencia." };
  }

  revalidatePath("/licencias");
  return { status: "success", message: "Licencia rechazada." };
}
