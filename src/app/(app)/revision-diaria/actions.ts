"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";
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

/**
 * Server Actions de Fase 8 (PASO 6). Cada una crea su PROPIO cliente de
 * sesión (nunca admin) -- así RLS (`can_manage_employee`) sigue siendo el
 * enforcement real de área/rol, exactamente igual que si el supervisor
 * hubiera escrito la fila a mano. Nunca se recibe/usa `service_role` aquí.
 */

function revalidateReview(employeeId: string, date: string) {
  revalidatePath(`/revision-diaria`);
  void employeeId;
  void date;
}

export async function decideLateArrivalAction(formData: FormData) {
  const supabase = await createClient();
  const lateArrivalRecordId = String(formData.get("lateArrivalRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const justified = formData.get("justified") === "true";
  const reason = (formData.get("reason") as string) || null;

  await decideLateArrival(supabase, { lateArrivalRecordId, justified, reason });
  revalidateReview(employeeId, date);
}

export async function decideOvertimeAction(formData: FormData) {
  const supabase = await createClient();
  const overtimeRecordId = String(formData.get("overtimeRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const action = String(formData.get("action")) as OvertimeDecisionAction;
  const reason = (formData.get("reason") as string) || null;

  await decideOvertime(supabase, { overtimeRecordId, action, reason });
  revalidateReview(employeeId, date);
}

export async function markEarlyDepartureMedicalAction(formData: FormData) {
  const supabase = await createClient();
  const earlyDepartureRecordId = String(formData.get("earlyDepartureRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const reason = (formData.get("reason") as string) || null;

  await markEarlyDepartureMedical(supabase, { earlyDepartureRecordId, workDate: date, reason });
  revalidateReview(employeeId, date);
}

export async function confirmEarlyDepartureMedicalDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const earlyDepartureRecordId = String(formData.get("earlyDepartureRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const reason = (formData.get("reason") as string) || null;

  await confirmEarlyDepartureMedicalDocument(supabase, { earlyDepartureRecordId, workDate: date, reason });
  revalidateReview(employeeId, date);
}

export async function decideEarlyDepartureOtherAction(formData: FormData) {
  const supabase = await createClient();
  const earlyDepartureRecordId = String(formData.get("earlyDepartureRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const reasonCategory = String(formData.get("reasonCategory")) as NonMedicalEarlyDepartureReason;
  const reason = (formData.get("reason") as string) || null;

  await decideEarlyDepartureOther(supabase, { earlyDepartureRecordId, reasonCategory, reason });
  revalidateReview(employeeId, date);
}

export async function markAbsencePendingDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const startDate = String(formData.get("startDate"));
  const reason = (formData.get("reason") as string) || null;

  await markAbsencePendingDocument(supabase, { absenceRecordId, startDate, reason });
  revalidateReview(employeeId, date);
}

export async function confirmAbsenceDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const startDate = String(formData.get("startDate"));
  const reason = (formData.get("reason") as string) || null;

  await confirmAbsenceDocument(supabase, { absenceRecordId, startDate, reason });
  revalidateReview(employeeId, date);
}

export async function disputeAbsenceAction(formData: FormData) {
  const supabase = await createClient();
  const absenceRecordId = String(formData.get("absenceRecordId"));
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
  const reason = (formData.get("reason") as string) || null;

  await disputeAbsence(supabase, { absenceRecordId, reason });
  revalidateReview(employeeId, date);
}

export async function uploadDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const employeeId = String(formData.get("employeeId"));
  const date = String(formData.get("date"));
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
  revalidateReview(employeeId, date);
}
