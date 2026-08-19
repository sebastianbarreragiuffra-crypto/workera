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
import { uploadSupportingDocument, type SupportingDocumentType, type SupportingDocumentRelation } from "../../../lib/decisions/documents";
import { getDailyReviewBoard, sortPendingCards, findNextPendingEmployeeId } from "../../../lib/view-models/daily-review-view";
import type { AreaCode } from "../../../lib/access/scope";

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
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const area = String(formData.get("area")) as AreaCode;
  const reason = (formData.get("reason") as string) || null;

  await disputeAbsence(supabase, { absenceRecordId, reason });
  await goToNextPending(area, date, employeeId, "licencia-disputada");
}

export async function uploadDocumentAction(formData: FormData) {
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
