import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin-client";
import type { ExpenseReceiptMime } from "@/lib/expenses/receipts";

type CaptureSource = "WEB_UPLOAD" | "WEB_CAMERA";
type InboundCaptureSource = "EMAIL";
type StoreFailure = "LIMIT" | "STORAGE" | "REGISTER";

export type ExpenseFileStoreResult =
  | { ok: true }
  | { ok: false; reason: StoreFailure };

export type InboundExpenseFileStoreResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: StoreFailure };

interface ExpenseFileInput {
  actorId: string;
  companyId: string;
  originalFilename: string;
  mimeType: ExpenseReceiptMime;
  extension: string;
  bytes: ArrayBuffer;
}

async function cleanupIfUnregistered(storagePath: string): Promise<void> {
  const admin = createAdminClient("expense-receipt-storage");
  const [receipt, capture] = await Promise.all([
    admin.from("expense_receipts").select("id").eq("storage_path", storagePath).maybeSingle(),
    admin.from("expense_receipt_captures").select("id").eq("storage_path", storagePath).maybeSingle(),
  ]);
  // Si la confirmación falla, se conserva el objeto: es preferible un
  // huérfano privado recuperable a borrar un comprobante que sí se registró.
  if (receipt.error || capture.error || receipt.data || capture.data) return;
  const { error } = await admin.storage.from("expense-receipts").remove([storagePath]);
  if (error) console.error("expense-capture: no se pudo limpiar un objeto no registrado.", { storagePath });
}

async function uploadPrivateObject(storagePath: string, input: ExpenseFileInput): Promise<boolean> {
  const admin = createAdminClient("expense-receipt-storage");
  const { error } = await admin.storage.from("expense-receipts").upload(storagePath, input.bytes, {
    contentType: input.mimeType,
    cacheControl: "3600",
    upsert: false,
  });
  return !error;
}

function checksum(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export async function storeExpenseCapture(
  input: ExpenseFileInput & { source: CaptureSource }
): Promise<ExpenseFileStoreResult> {
  const objectId = randomUUID();
  const storagePath = `${input.companyId}/${input.actorId}/inbox/${objectId}.${input.extension}`;
  if (!await uploadPrivateObject(storagePath, input)) return { ok: false, reason: "STORAGE" };

  const admin = createAdminClient("expense-receipt-storage");
  const { error } = await admin.rpc("register_expense_receipt_capture", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_storage_path: storagePath,
    p_original_filename: input.originalFilename,
    p_mime_type: input.mimeType,
    p_file_size: input.bytes.byteLength,
    p_checksum_sha256: checksum(input.bytes),
    p_source: input.source,
  });
  if (error) {
    await cleanupIfUnregistered(storagePath);
    return { ok: false, reason: error.code === "54000" ? "LIMIT" : "REGISTER" };
  }
  return { ok: true };
}

export async function storeInboundExpenseCapture(
  input: ExpenseFileInput & {
    source: InboundCaptureSource;
    externalMessageId: string;
    providerEmailId: string;
    claimToken: string;
  }
): Promise<InboundExpenseFileStoreResult> {
  const admin = createAdminClient("expense-receipt-storage");
  const { data: existing, error: existingError } = await admin
    .from("expense_receipt_captures")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("source", input.source)
    .eq("external_message_id", input.externalMessageId)
    .maybeSingle();
  if (existingError) return { ok: false, reason: "REGISTER" };
  if (existing) return { ok: true, duplicate: true };

  const objectId = randomUUID();
  const storagePath = `${input.companyId}/${input.actorId}/inbox/${objectId}.${input.extension}`;
  if (!await uploadPrivateObject(storagePath, input)) return { ok: false, reason: "STORAGE" };

  const { data: captureId, error } = await admin.rpc("register_inbound_expense_receipt_capture", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_storage_path: storagePath,
    p_original_filename: input.originalFilename,
    p_mime_type: input.mimeType,
    p_file_size: input.bytes.byteLength,
    p_checksum_sha256: checksum(input.bytes),
    p_external_message_id: input.externalMessageId,
    p_provider_email_id: input.providerEmailId,
    p_claim_token: input.claimToken,
  });
  if (error || !captureId) {
    await cleanupIfUnregistered(storagePath);
    return { ok: false, reason: error?.code === "54000" ? "LIMIT" : "REGISTER" };
  }

  // El RPC devuelve la fila existente ante una carrera entre dos reintentos.
  // En ese caso el objeto recién subido no es el canónico y se limpia.
  const { data: registered, error: registeredError } = await admin
    .from("expense_receipt_captures")
    .select("storage_path")
    .eq("id", captureId)
    .single();
  if (registeredError || !registered) {
    await cleanupIfUnregistered(storagePath);
    return { ok: false, reason: "REGISTER" };
  }
  const duplicate = registered.storage_path !== storagePath;
  if (duplicate) await cleanupIfUnregistered(storagePath);
  return { ok: true, duplicate };
}

export async function storeWhatsappExpenseCapture(
  input: ExpenseFileInput & {
    providerMessageHash: string;
    claimToken: string;
  }
): Promise<InboundExpenseFileStoreResult> {
  const admin = createAdminClient("expense-receipt-storage");
  const { data: existing, error: existingError } = await admin
    .from("expense_receipt_captures")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("source", "WHATSAPP")
    .eq("external_message_id", input.providerMessageHash)
    .maybeSingle();
  if (existingError) return { ok: false, reason: "REGISTER" };
  if (existing) return { ok: true, duplicate: true };

  const objectId = randomUUID();
  const storagePath = `${input.companyId}/${input.actorId}/inbox/${objectId}.${input.extension}`;
  if (!await uploadPrivateObject(storagePath, input)) return { ok: false, reason: "STORAGE" };

  const { data: captureId, error } = await admin.rpc("register_expense_receipt_whatsapp_capture", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_storage_path: storagePath,
    p_original_filename: input.originalFilename,
    p_mime_type: input.mimeType,
    p_file_size: input.bytes.byteLength,
    p_checksum_sha256: checksum(input.bytes),
    p_provider_message_hash: input.providerMessageHash,
    p_claim_token: input.claimToken,
  });
  if (error || !captureId) {
    await cleanupIfUnregistered(storagePath);
    return { ok: false, reason: error?.code === "54000" ? "LIMIT" : "REGISTER" };
  }

  const { data: registered, error: registeredError } = await admin
    .from("expense_receipt_captures")
    .select("storage_path")
    .eq("id", captureId)
    .single();
  if (registeredError || !registered) {
    await cleanupIfUnregistered(storagePath);
    return { ok: false, reason: "REGISTER" };
  }
  const duplicate = registered.storage_path !== storagePath;
  if (duplicate) await cleanupIfUnregistered(storagePath);
  return { ok: true, duplicate };
}

export async function storeExpenseReceipt(
  input: ExpenseFileInput & { reportId: string; itemId: string }
): Promise<ExpenseFileStoreResult> {
  const objectId = randomUUID();
  const storagePath = `${input.companyId}/${input.actorId}/${input.reportId}/${input.itemId}/${objectId}.${input.extension}`;
  if (!await uploadPrivateObject(storagePath, input)) return { ok: false, reason: "STORAGE" };

  const admin = createAdminClient("expense-receipt-storage");
  const { error } = await admin.rpc("register_expense_receipt_trusted", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_item_id: input.itemId,
    p_storage_path: storagePath,
    p_original_filename: input.originalFilename,
    p_mime_type: input.mimeType,
    p_file_size: input.bytes.byteLength,
    p_checksum_sha256: checksum(input.bytes),
  });
  if (error) {
    await cleanupIfUnregistered(storagePath);
    return { ok: false, reason: "REGISTER" };
  }
  return { ok: true };
}

export async function discardExpenseCapture(input: {
  actorId: string;
  companyId: string;
  captureId: string;
}): Promise<boolean> {
  const admin = createAdminClient("expense-receipt-storage");
  const { data: storagePath, error } = await admin.rpc("discard_expense_receipt_capture", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_capture_id: input.captureId,
  });
  if (error || !storagePath) return false;

  const expectedPrefix = `${input.companyId}/${input.actorId}/inbox/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    console.error("expense-capture: el RPC devolvió una ruta fuera del ámbito esperado.", { captureId: input.captureId });
    return false;
  }
  const { error: removeError } = await admin.storage.from("expense-receipts").remove([storagePath]);
  if (removeError) {
    // La metadata ya está descartada y no vuelve a exponerse. Se conserva el
    // error para limpieza operativa del objeto privado.
    console.error("expense-capture: no se pudo retirar el objeto descartado.", { captureId: input.captureId });
  }
  return true;
}
