"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../lib/supabase/server";
import { uploadSupportingDocument, getSignedDocumentUrl, type SupportingDocumentType } from "../../../lib/decisions/documents";

export async function uploadGeneralDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const employeeId = String(formData.get("employeeId"));
  const documentType = String(formData.get("documentType")) as SupportingDocumentType;
  const file = formData.get("file") as File | null;

  if (!employeeId || !file || file.size === 0) {
    throw new Error("Selecciona un trabajador y un archivo antes de adjuntar.");
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  await uploadSupportingDocument(supabase, {
    employeeId,
    documentType,
    originalFilename: file.name,
    mimeType: file.type || "application/octet-stream",
    fileBytes,
  });

  revalidatePath("/documentos");
  redirect(`/documentos?hecho=documento-adjuntado`);
}

export async function viewDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const documentId = String(formData.get("documentId"));
  const signedUrl = await getSignedDocumentUrl(supabase, documentId);
  redirect(signedUrl);
}
