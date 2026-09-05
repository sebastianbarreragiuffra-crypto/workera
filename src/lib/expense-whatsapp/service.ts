import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { storeWhatsappExpenseCapture } from "@/lib/expense-capture/service";
import { EXPENSE_RECEIPT_MAX_BYTES, validateExpenseReceiptFile } from "@/lib/expenses/receipts";
import { createAdminClient } from "@/lib/supabase/admin-client";
import type { ExpenseWhatsappProviderConfig } from "./config";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MEDIA_ID = /^\d{5,64}$/;
const WA_ID = /^\d{5,32}$/;
const SUPPORTED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);

const mediaSchema = z.object({
  id: z.string(),
  url: z.url(),
  mime_type: z.string(),
  file_size: z.coerce.number().int().positive(),
});

const messageSchema = z.object({
  id: z.string().min(1).max(240),
  from: z.string(),
  type: z.string(),
  text: z.object({ body: z.string().max(200) }).optional(),
  image: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
  document: z.object({ id: z.string(), mime_type: z.string().optional(), filename: z.string().optional() }).optional(),
});

const payloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    changes: z.array(z.object({
      field: z.string(),
      value: z.object({
        metadata: z.object({ phone_number_id: z.string() }),
        messages: z.array(messageSchema).optional(),
      }),
    })),
  })),
});

type Message = z.infer<typeof messageSchema>;
type ClaimResult = "CLAIMED" | "COMPLETED" | "IN_PROGRESS" | "RATE_LIMITED" | "LIMIT";

export interface ExpenseWhatsappProcessSummary {
  paired: number;
  stored: number;
  duplicate: number;
  ignored: number;
}

export function verifyMetaWebhookSignature(rawBody: Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const received = signature.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export function normalizeWhatsappPairingCode(value: string): string | null {
  const match = /^VINCULAR\s+([A-F0-9-]{24,40})$/i.exec(value.trim());
  if (!match) return null;
  const compact = match[1].replace(/-/g, "").toUpperCase();
  return /^[A-F0-9]{24}$/.test(compact) ? compact : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashWaId(waId: string, secret: string): string {
  return createHmac("sha256", secret).update(waId).digest("hex");
}

function safeFilename(value: string | undefined, extension: string): string {
  const cleaned = (value ?? "comprobante")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 220);
  return `${cleaned.replace(/\.(pdf|jpe?g|png)$/i, "") || "comprobante"}.${extension}`;
}

export function isTrustedWhatsappMediaUrl(url: string, config: ExpenseWhatsappProviderConfig): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && !parsed.username && !parsed.password
      && config.mediaHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function claimPairing(tokenHash: string, waIdHash: string): Promise<boolean> {
  const admin = createAdminClient("expense-whatsapp-ingestion");
  const { data, error } = await admin.rpc("claim_expense_receipt_whatsapp_pairing", {
    p_token_hash: tokenHash,
    p_wa_id_hash: waIdHash,
  });
  if (error) throw new Error("No se pudo confirmar la vinculación.");
  return (data?.length ?? 0) === 1;
}

async function resolveSender(waIdHash: string): Promise<{ companyId: string; userId: string } | null> {
  const admin = createAdminClient("expense-whatsapp-ingestion");
  const { data, error } = await admin.rpc("resolve_expense_receipt_whatsapp_sender", { p_wa_id_hash: waIdHash });
  if (error) throw new Error("No se pudo resolver el remitente.");
  const sender = data?.[0];
  return sender ? { companyId: sender.company_id, userId: sender.user_id } : null;
}

async function claimEvent(input: {
  actorId: string;
  companyId: string;
  providerMessageHash: string;
}): Promise<{ result: ClaimResult; claimToken: string | null }> {
  const admin = createAdminClient("expense-whatsapp-ingestion");
  const { data, error } = await admin.rpc("claim_expense_receipt_whatsapp_event", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_provider_message_hash: input.providerMessageHash,
  });
  const claim = data?.[0];
  if (error || !claim || !["CLAIMED", "COMPLETED", "IN_PROGRESS", "RATE_LIMITED", "LIMIT"].includes(claim.result)) {
    throw new Error("No se pudo reclamar el mensaje.");
  }
  return { result: claim.result as ClaimResult, claimToken: claim.claim_token };
}

async function reserveBytes(input: {
  actorId: string;
  companyId: string;
  providerMessageHash: string;
  claimToken: string;
  size: number;
}): Promise<boolean> {
  const admin = createAdminClient("expense-whatsapp-ingestion");
  const { data, error } = await admin.rpc("reserve_expense_receipt_whatsapp_bytes", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_provider_message_hash: input.providerMessageHash,
    p_claim_token: input.claimToken,
    p_reserved_bytes: input.size,
  });
  if (error || typeof data !== "boolean") throw new Error("No se pudo reservar la descarga.");
  return data;
}

async function finishEvent(input: {
  actorId: string;
  companyId: string;
  providerMessageHash: string;
  claimToken: string;
  success: boolean;
}): Promise<void> {
  const admin = createAdminClient("expense-whatsapp-ingestion");
  const rpc = input.success
    ? "complete_expense_receipt_whatsapp_event"
    : "release_expense_receipt_whatsapp_event";
  const { data, error } = await admin.rpc(rpc, {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_provider_message_hash: input.providerMessageHash,
    p_claim_token: input.claimToken,
  });
  if (error || data !== true) throw new Error("No se pudo cerrar el mensaje.");
}

async function getMediaDescriptor(mediaId: string, config: ExpenseWhatsappProviderConfig) {
  if (!MEDIA_ID.test(mediaId)) return null;
  const endpoint = `https://graph.facebook.com/${config.graphVersion}/${mediaId}`;
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${config.accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("No se pudo consultar el archivo de WhatsApp.");
  const parsed = mediaSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.id !== mediaId
    || !SUPPORTED_MIME.has(parsed.data.mime_type.split(";", 1)[0].toLowerCase())
    || parsed.data.file_size > EXPENSE_RECEIPT_MAX_BYTES
    || !isTrustedWhatsappMediaUrl(parsed.data.url, config)) return null;
  return parsed.data;
}

async function downloadMedia(url: string, config: ExpenseWhatsappProviderConfig): Promise<ArrayBuffer | null> {
  if (!isTrustedWhatsappMediaUrl(url, config)) return null;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error("No se pudo descargar el archivo de WhatsApp.");
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size <= 0 || size > EXPENSE_RECEIPT_MAX_BYTES) return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > EXPENSE_RECEIPT_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (total <= 0) return null;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

function mediaOf(message: Message): { id: string; filename?: string } | null {
  if (message.type === "image" && message.image) return { id: message.image.id };
  if (message.type === "document" && message.document) return { id: message.document.id, filename: message.document.filename };
  return null;
}

async function processMessage(
  message: Message,
  config: ExpenseWhatsappProviderConfig,
  summary: ExpenseWhatsappProcessSummary
): Promise<void> {
  if (!WA_ID.test(message.from)) { summary.ignored += 1; return; }
  const waIdHash = hashWaId(message.from, config.linkSecret);
  if (message.type === "text" && message.text) {
    const code = normalizeWhatsappPairingCode(message.text.body);
    if (!code) { summary.ignored += 1; return; }
    if (await claimPairing(sha256(code), waIdHash)) summary.paired += 1;
    else summary.ignored += 1;
    return;
  }

  const media = mediaOf(message);
  if (!media) { summary.ignored += 1; return; }
  const sender = await resolveSender(waIdHash);
  if (!sender) { summary.ignored += 1; return; }

  const providerMessageHash = sha256(message.id);
  const claim = await claimEvent({ ...sender, actorId: sender.userId, providerMessageHash });
  if (claim.result === "COMPLETED") { summary.duplicate += 1; return; }
  if (claim.result !== "CLAIMED" || !claim.claimToken) { summary.ignored += 1; return; }

  const event = { ...sender, actorId: sender.userId, providerMessageHash, claimToken: claim.claimToken };
  try {
    const descriptor = await getMediaDescriptor(media.id, config);
    if (!descriptor || !await reserveBytes({ ...event, size: descriptor.file_size })) {
      await finishEvent({ ...event, success: true });
      summary.ignored += 1;
      return;
    }
    const bytes = await downloadMedia(descriptor.url, config);
    const mime = descriptor.mime_type.split(";", 1)[0].toLowerCase();
    if (!bytes || bytes.byteLength !== descriptor.file_size) {
      await finishEvent({ ...event, success: true });
      summary.ignored += 1;
      return;
    }
    const file = new File([bytes], media.filename ?? "comprobante", { type: mime });
    const validation = await validateExpenseReceiptFile(file);
    if (!validation.ok || !validation.mimeType || !validation.extension) {
      await finishEvent({ ...event, success: true });
      summary.ignored += 1;
      return;
    }
    const stored = await storeWhatsappExpenseCapture({
      actorId: sender.userId,
      companyId: sender.companyId,
      providerMessageHash,
      claimToken: claim.claimToken,
      originalFilename: safeFilename(media.filename, validation.extension),
      mimeType: validation.mimeType,
      extension: validation.extension,
      bytes,
    });
    if (!stored.ok) throw new Error("No se pudo registrar el comprobante de WhatsApp.");
    await finishEvent({ ...event, success: true });
    if (stored.duplicate) summary.duplicate += 1;
    else summary.stored += 1;
  } catch (error) {
    try { await finishEvent({ ...event, success: false }); } catch { /* la lease expira sola */ }
    throw error;
  }
}

export async function processMetaExpenseWhatsapp(
  payload: unknown,
  config: ExpenseWhatsappProviderConfig
): Promise<ExpenseWhatsappProcessSummary> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Payload de WhatsApp inválido.");
  const summary: ExpenseWhatsappProcessSummary = { paired: 0, stored: 0, duplicate: 0, ignored: 0 };
  const messages = parsed.data.entry.flatMap((entry) => entry.changes.flatMap((change) => {
    if (change.field !== "messages" || change.value.metadata.phone_number_id !== config.phoneNumberId) return [];
    return change.value.messages ?? [];
  }));

  for (const message of messages) await processMessage(message, config, summary);
  return summary;
}
