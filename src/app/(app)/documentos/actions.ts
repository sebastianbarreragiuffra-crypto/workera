"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { uploadSupportingDocument, getSignedDocumentUrl, MAX_SUPPORTING_DOCUMENT_SIZE_BYTES, type SupportingDocumentType, type SupportingDocumentRelation } from "../../../lib/decisions/documents";
import { assertEmployeeAccessAllowed, type CallerRole } from "../../../lib/access/scope";

async function requireActiveProfile() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  return profile;
}

export async function uploadGeneralDocumentAction(formData: FormData) {
  const profile = await requireActiveProfile();
  const supabase = await createClient();
  const employeeId = String(formData.get("employeeId"));
  const documentType = String(formData.get("documentType")) as SupportingDocumentType;
  const file = formData.get("file") as File | null;
  const relationValue = String(formData.get("relation") ?? "");

  if (!employeeId || !file || file.size === 0) {
    throw new Error("Selecciona un trabajador y un archivo antes de adjuntar.");
  }
  if (file.size > MAX_SUPPORTING_DOCUMENT_SIZE_BYTES) {
    throw new Error("El archivo supera el máximo permitido de 10 MB.");
  }
  await assertEmployeeAccessAllowed(supabase, profile.role as CallerRole, employeeId);

  let relation: SupportingDocumentRelation | undefined;
  if (relationValue) {
    const [kind, recordId] = relationValue.split(":");
    if ((kind !== "EARLY_DEPARTURE" && kind !== "ABSENCE") || !recordId) throw new Error("El caso pendiente seleccionado no es válido.");
    const table = kind === "EARLY_DEPARTURE" ? "early_departure_records" : "absence_records";
    const { data: record, error } = await supabase.from(table).select("id, employee_id").eq("id", recordId).eq("employee_id", employeeId).single();
    if (error || !record) throw new Error("El caso pendiente no corresponde al trabajador seleccionado.");
    relation = kind === "EARLY_DEPARTURE" ? { kind, earlyDepartureRecordId: recordId } : { kind, absenceRecordId: recordId };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  await uploadSupportingDocument(supabase, {
    employeeId,
    documentType,
    originalFilename: file.name,
    mimeType: file.type || "application/octet-stream",
    fileBytes,
    relation,
  });

  revalidatePath("/documentos");
  if (relation) revalidatePath("/revision-diaria");
  redirect(`/documentos?hecho=documento-adjuntado`);
}

export async function viewDocumentAction(formData: FormData) {
  await requireActiveProfile();
  const supabase = await createClient();
  const documentId = String(formData.get("documentId"));
  const signedUrl = await getSignedDocumentUrl(supabase, documentId);
  redirect(signedUrl);
}
