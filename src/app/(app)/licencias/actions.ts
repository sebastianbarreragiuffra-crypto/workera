"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { requireMedicalLicenseApprover } from "../../../lib/supabase/authorize";
import { assertEmployeeAccessAllowed, type CallerRole } from "../../../lib/access/scope";
import { uploadMedicalLicense, approveMedicalLicense, rejectMedicalLicense } from "../../../lib/decisions/medical-license";

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
}

export async function uploadMedicalLicenseAction(_prev: UploadMedicalLicenseActionState, formData: FormData): Promise<UploadMedicalLicenseActionState> {
  const profile = await requireAuthenticatedProfile();
  const supabase = await createClient();

  const employeeId = formData.get("employeeId") as string | null;
  const startDate = formData.get("startDate") as string | null;
  const endDate = formData.get("endDate") as string | null;
  const file = formData.get("file") as File | null;

  if (!employeeId || !startDate || !endDate) {
    return { status: "error", message: "Selecciona el trabajador y el rango de fechas de la licencia." };
  }
  if (!file || file.size === 0) {
    return { status: "error", message: "Adjunta el documento de la licencia médica." };
  }
  if (endDate < startDate) {
    return { status: "error", message: "La fecha de término no puede ser anterior a la fecha de inicio." };
  }

  try {
    // Nunca confiar en que el cliente esté autorizado para este empleado -- mismo criterio
    // ya usado en revision-diaria/empleados/[id] para cualquier acción que reciba un employeeId.
    await assertEmployeeAccessAllowed(supabase, profile.role, employeeId);
  } catch {
    return { status: "error", message: "No tienes acceso a este trabajador." };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());

  try {
    await uploadMedicalLicense(supabase, {
      employeeId,
      proposedStartDate: startDate,
      proposedEndDate: endDate,
      originalFilename: file.name,
      mimeType: file.type || "application/octet-stream",
      fileBytes,
      uploadedBy: profile.id,
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos subir la licencia." };
  }

  revalidatePath("/licencias");
  return { status: "success", message: "Licencia subida -- queda pendiente de aprobación de RRHH." };
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
  if (confirmedEndDate < confirmedStartDate) {
    return { status: "error", message: "La fecha de término no puede ser anterior a la fecha de inicio." };
  }

  try {
    await approveMedicalLicense(supabase, { approvalId, confirmedStartDate, confirmedEndDate });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos aprobar la licencia." };
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
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos rechazar la licencia." };
  }

  revalidatePath("/licencias");
  return { status: "success", message: "Licencia rechazada." };
}
