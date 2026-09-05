"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { decideLateArrival } from "../../../lib/decisions/late-arrival-decisions";
import { decideOvertime, type OvertimeDecisionAction } from "../../../lib/decisions/overtime-decisions";
import {
  markEarlyDepartureMedical,
  confirmEarlyDepartureMedicalDocument,
  decideEarlyDepartureOther,
  type NonMedicalEarlyDepartureReason,
} from "../../../lib/decisions/early-departure-decisions";
import { markAbsencePendingDocument, confirmAbsenceDocument, disputeAbsence } from "../../../lib/decisions/absence-decisions";
import { submitAttendanceCorrection } from "../../../lib/decisions/attendance-corrections";
import { reprocessEmployeeDay } from "../../../lib/rule-engine/service";
import { uploadSupportingDocument, MAX_SUPPORTING_DOCUMENT_SIZE_BYTES, type SupportingDocumentType, type SupportingDocumentRelation } from "../../../lib/decisions/documents";
import { getDailyReviewBoard, sortPendingCards, findNextPendingEmployeeId } from "../../../lib/view-models/daily-review-view";
import { assertEmployeeAccessAllowed, type AreaCode, type CallerRole } from "../../../lib/access/scope";

/**
 * Server Actions de Fase 8, ampliadas en Fase 8B.2 (PASO 23/24: feedback +
 * "siguiente pendiente" automático). Cada una crea su PROPIO cliente de
 * sesión (nunca admin) -- así RLS (`can_manage_employee`) sigue siendo el
 * enforcement real de área/rol, exactamente igual que si el supervisor
 * hubiera escrito la fila a mano. Nunca se recibe/usa `service_role` aquí.
 *
 * Tras cada decisión exitosa se recalcula la cola de pendientes (reutiliza
 * `getDailyReviewBoard`/`sortPendingCards`, Fase 8B.2 -- nunca una segunda
 * implementación del orden) y se redirige directamente al siguiente caso
 * pendiente, con `?hecho=<feedback>` para el banner de confirmación. Si no
 * queda ninguno, redirige a la lista (vacía -> empty state positivo).
 */

async function requireActiveProfile() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  return profile;
}

async function goToNextPending(area: AreaCode, date: string, decidedEmployeeId: string, feedback: string): Promise<never> {
  revalidatePath(`/revision-diaria`);

  const profile = await getCurrentProfile();
  const supabase = await createClient();

  if (!profile?.role) redirect(`/revision-diaria?fecha=${date}&area=${area}&filtro=pendientes&hecho=${feedback}`);

  const board = await getDailyReviewBoard(supabase, profile.role, area, date);
  const pending = sortPendingCards(board.cards.filter((c) => c.needsReview));
  const nextId = findNextPendingEmployeeId(pending, decidedEmployeeId);

  const base = `/revision-diaria?fecha=${date}&area=${area}&filtro=pendientes&hecho=${feedback}`;
  redirect(nextId ? `${base}&empleado=${nextId}` : base);
}

export async function decideLateArrivalAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const lateArrivalRecordId = String(formData.get("lateArrivalRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const justified = formData.get("justified") === "true";
  const reason = (formData.get("reason") as string) || null;

  await decideLateArrival(supabase, { lateArrivalRecordId, justified, reason });
  await goToNextPending(area, date, employeeId, justified ? "atraso-justificado" : "atraso-no-justificado");
}

export async function decideOvertimeAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const overtimeRecordId = String(formData.get("overtimeRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const action = String(formData.get("action")) as OvertimeDecisionAction;
  const reason = (formData.get("reason") as string) || null;

  await decideOvertime(supabase, { overtimeRecordId, action, reason });
  await goToNextPending(area, date, employeeId, action === "APPROVE" ? "ot-aprobada" : "ot-rechazada");
}

export async function markEarlyDepartureMedicalAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const earlyDepartureRecordId = String(formData.get("earlyDepartureRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const reason = (formData.get("reason") as string) || null;

  await markEarlyDepartureMedical(supabase, { earlyDepartureRecordId, workDate: date, reason });
  revalidatePath(`/revision-diaria`);
  redirect(`/revision-diaria?fecha=${date}&area=${area}&filtro=pendientes&empleado=${employeeId}&hecho=medico-marcado`);
}

export async function confirmEarlyDepartureMedicalDocumentAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const earlyDepartureRecordId = String(formData.get("earlyDepartureRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const reason = (formData.get("reason") as string) || null;

  await confirmEarlyDepartureMedicalDocument(supabase, { earlyDepartureRecordId, workDate: date, reason });
  await goToNextPending(area, date, employeeId, "medico-confirmado");
}

export async function decideEarlyDepartureOtherAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const earlyDepartureRecordId = String(formData.get("earlyDepartureRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const reasonCategory = String(formData.get("reasonCategory")) as NonMedicalEarlyDepartureReason;
  const reason = (formData.get("reason") as string) || null;

  await decideEarlyDepartureOther(supabase, { earlyDepartureRecordId, reasonCategory, reason });
  await goToNextPending(area, date, employeeId, "salida-decidida");
}

export async function markAbsencePendingDocumentAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const startDate = String(formData.get("startDate"));
  const reason = (formData.get("reason") as string) || null;

  await markAbsencePendingDocument(supabase, { absenceRecordId, startDate, reason });
  revalidatePath(`/revision-diaria`);
  redirect(`/revision-diaria?fecha=${date}&area=${area}&filtro=pendientes&empleado=${employeeId}&hecho=licencia-marcada`);
}

export async function confirmAbsenceDocumentAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const startDate = String(formData.get("startDate"));
  const reason = (formData.get("reason") as string) || null;

  await confirmAbsenceDocument(supabase, { absenceRecordId, startDate, reason });
  await goToNextPending(area, date, employeeId, "licencia-confirmada");
}

export async function disputeAbsenceAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const reason = (formData.get("reason") as string) || null;

  await disputeAbsence(supabase, { absenceRecordId, reason });
  await goToNextPending(area, date, employeeId, "licencia-disputada");
}

/**
 * Corrección de marcación (MB-3). El caso real que motiva esto: un trabajador
 * olvida marcar la salida, el motor no puede calcular ni horas extra ni salida
 * anticipada, y hasta ahora la UI solo mostraba un aviso sin acción posible.
 *
 * Dos pasos, en este orden:
 *  1. La corrección se inserta con el cliente de SESIÓN, para que la RLS
 *     (`corrected_by = auth.uid() AND can_manage_employee`) sea el gate real
 *     de área. Todas las validaciones (mismo día, orden de horas, período
 *     cerrado, conflicto con una decisión de horas extra) las aplica la base.
 *  2. Recién entonces se re-deriva ese trabajador/día bajo service_role, para
 *     que atraso, salida anticipada y horas extra se recalculen sobre la hora
 *     corregida. Sin este segundo paso la corrección resolvería la bandera
 *     pero no produciría ningún candidato -- el trabajo quedaría a medias.
 */
export async function submitAttendanceCorrectionAction(formData: FormData) {
  const profile = await requireActiveProfile();
  const supabase = await createClient();

  const attendanceRecordId = String(formData.get("attendanceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const correctedClockIn = (formData.get("correctedClockIn") as string)?.trim() || null;
  const correctedClockOut = (formData.get("correctedClockOut") as string)?.trim() || null;
  const correctedClockOutNextDay = formData.get("correctedClockOutNextDay") === "on";
  const reason = String(formData.get("reason") ?? "");

  await submitAttendanceCorrection(supabase, {
    attendanceRecordId,
    employeeId,
    workDate: date,
    correctedClockIn,
    correctedClockOut,
    correctedClockOutNextDay,
    reason,
    correctedBy: profile.id,
  });

  await reprocessEmployeeDay(employeeId, date);

  revalidatePath(`/revision-diaria`);
  redirect(`/revision-diaria?fecha=${date}&area=${area}&filtro=pendientes&empleado=${employeeId}&hecho=marcacion-corregida`);
}

export async function uploadDocumentAction(formData: FormData) {
  const profile = await requireActiveProfile();
  const supabase = await createClient();
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const documentType = String(formData.get("documentType")) as SupportingDocumentType;
  const relationKind = String(formData.get("relationKind"));
  const relationId = String(formData.get("relationId"));
  const file = formData.get("file") as File | null;

  if (!file || file.size === 0) {
    throw new Error("Selecciona un archivo antes de adjuntar.");
  }
  if (file.size > MAX_SUPPORTING_DOCUMENT_SIZE_BYTES) {
    throw new Error("El archivo supera el máximo permitido de 10 MB.");
  }
  await assertEmployeeAccessAllowed(supabase, profile.role as CallerRole, employeeId);

  const relation: SupportingDocumentRelation =
    relationKind === "ABSENCE"
      ? { kind: "ABSENCE", absenceRecordId: relationId }
      : relationKind === "LATE_ARRIVAL_DECISION"
        ? { kind: "LATE_ARRIVAL_DECISION", lateArrivalDecisionId: relationId }
        : { kind: "EARLY_DEPARTURE", earlyDepartureRecordId: relationId };

  const fileBytes = new Uint8Array(await file.arrayBuffer());

  await uploadSupportingDocument(supabase, {
    employeeId,
    documentType,
    originalFilename: file.name,
    mimeType: file.type || "application/octet-stream",
    fileBytes,
    relation,
  });
  revalidatePath(`/revision-diaria`);
  redirect(`/revision-diaria?fecha=${date}&area=${area}&filtro=pendientes&empleado=${employeeId}&hecho=documento-adjuntado`);
}
