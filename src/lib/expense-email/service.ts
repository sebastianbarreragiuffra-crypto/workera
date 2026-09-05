import "server-only";

import { createHash } from "node:crypto";
import { Resend, type EmailReceivedEvent } from "resend";
import { storeInboundExpenseCapture } from "@/lib/expense-capture/service";
import { EXPENSE_RECEIPT_MAX_BYTES, validateExpenseReceiptFile } from "@/lib/expenses/receipts";
import { createAdminClient } from "@/lib/supabase/admin-client";
import type { ExpenseEmailProviderConfig } from "./config";
import { isTrustedResendAttachmentUrl, resolveSingleExpenseAliasToken, safeAttachmentFilename } from "./recipients";

const MAX_ATTACHMENTS_PER_EMAIL = 10;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

type ExpenseEmailEventClaim = "CLAIMED" | "COMPLETED" | "IN_PROGRESS" | "RATE_LIMITED";

interface AttachmentDownloadDescriptor {
  id: string;
  filename?: string;
  size: number;
  content_type: string;
  content_disposition: "inline" | "attachment";
  download_url: string;
}

class AttachmentDownloadError extends Error {
  constructor(readonly status: number | null) {
    super("No se pudo descargar el adjunto.");
  }
}

export interface ExpenseEmailProcessSummary {
  stored: number;
  duplicate: number;
  ignored: number;
}

async function resolveAlias(aliasToken: string): Promise<{ companyId: string; userId: string } | null> {
  const admin = createAdminClient("expense-email-ingestion");
  const { data, error } = await admin.rpc("resolve_expense_receipt_email_alias", {
    p_alias_token: aliasToken,
  });
  if (error) throw new Error("No se pudo resolver el alias de recepción.");
  const alias = data?.[0];
  return alias ? { companyId: alias.company_id, userId: alias.user_id } : null;
}

async function claimExpenseEmailEvent(input: {
  actorId: string;
  companyId: string;
  providerEventId: string;
  providerEmailId: string;
  reservedSlots: number;
}): Promise<{ result: ExpenseEmailEventClaim; claimToken: string | null }> {
  const admin = createAdminClient("expense-email-ingestion");
  const { data, error } = await admin.rpc("claim_expense_receipt_email_event", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_provider_event_id: input.providerEventId,
    p_provider_email_id: input.providerEmailId,
    p_reserved_slots: input.reservedSlots,
  });
  const claim = data?.[0];
  if (error || !claim
    || !(["CLAIMED", "COMPLETED", "IN_PROGRESS", "RATE_LIMITED"] as unknown[]).includes(claim.result)) {
    throw new Error("No se pudo reclamar el evento de correo.");
  }
  return { result: claim.result as ExpenseEmailEventClaim, claimToken: claim.claim_token };
}

async function reserveExpenseEmailBytes(input: {
  actorId: string;
  companyId: string;
  providerEmailId: string;
  claimToken: string;
  reservedBytes: number;
}): Promise<boolean> {
  const admin = createAdminClient("expense-email-ingestion");
  const { data, error } = await admin.rpc("reserve_expense_receipt_email_bytes", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_provider_email_id: input.providerEmailId,
    p_claim_token: input.claimToken,
    p_reserved_bytes: input.reservedBytes,
  });
  if (error || typeof data !== "boolean") throw new Error("No se pudo reservar el tráfico del correo.");
  return data;
}

async function completeExpenseEmailEvent(
  actorId: string,
  companyId: string,
  providerEmailId: string,
  claimToken: string
): Promise<void> {
  const admin = createAdminClient("expense-email-ingestion");
  const { error } = await admin.rpc("complete_expense_receipt_email_event", {
    p_actor_id: actorId,
    p_company_id: companyId,
    p_provider_email_id: providerEmailId,
    p_claim_token: claimToken,
  });
  if (error) throw new Error("No se pudo completar el evento de correo.");
}

async function releaseExpenseEmailEvent(
  actorId: string,
  companyId: string,
  providerEmailId: string,
  claimToken: string
): Promise<void> {
  const admin = createAdminClient("expense-email-ingestion");
  const { error } = await admin.rpc("release_expense_receipt_email_event", {
    p_actor_id: actorId,
    p_company_id: companyId,
    p_provider_email_id: providerEmailId,
    p_claim_token: claimToken,
  });
  if (error) throw new Error("No se pudo liberar el evento de correo.");
}

function normalizedMime(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isSupportedExpenseEmailAttachment(attachment: {
  content_disposition: string | null;
  content_type: string;
}): boolean {
  return attachment.content_disposition === "attachment"
    && ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedMime(attachment.content_type));
}

export function selectProcessableExpenseEmailAttachments<T extends {
  content_disposition: string | null;
  content_type: string;
}>(attachments: T[]): T[] {
  return attachments
    .filter(isSupportedExpenseEmailAttachment)
    .slice(0, MAX_ATTACHMENTS_PER_EMAIL);
}

async function downloadAttachment(url: string, declaredSize: number): Promise<ArrayBuffer | null> {
  if (!isTrustedResendAttachmentUrl(url) || declaredSize <= 0 || declaredSize > EXPENSE_RECEIPT_MAX_BYTES) return null;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { accept: "application/pdf,image/jpeg,image/png" },
    });
  } catch {
    throw new AttachmentDownloadError(null);
  }
  if (!response.ok) throw new AttachmentDownloadError(response.status);

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > EXPENSE_RECEIPT_MAX_BYTES) return null;
  }
  if (!response.body) throw new AttachmentDownloadError(null);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let readResult: ReadableStreamReadResult<Uint8Array>;
    try {
      readResult = await reader.read();
    } catch {
      throw new AttachmentDownloadError(null);
    }
    const { done, value } = readResult;
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

async function downloadWithFreshUrl(
  resend: Resend,
  emailId: string,
  attachment: AttachmentDownloadDescriptor
): Promise<{ bytes: ArrayBuffer | null; attachment: AttachmentDownloadDescriptor }> {
  try {
    return { bytes: await downloadAttachment(attachment.download_url, attachment.size), attachment };
  } catch (error) {
    if (!(error instanceof AttachmentDownloadError)
      || ![401, 403, 404].includes(error.status ?? 0)) throw error;

    const refreshed = await resend.emails.receiving.attachments.get({ emailId, id: attachment.id });
    if (refreshed.error || !refreshed.data) throw new AttachmentDownloadError(error.status);
    return {
      bytes: await downloadAttachment(refreshed.data.download_url, refreshed.data.size),
      attachment: refreshed.data,
    };
  }
}

export async function processResendExpenseEmail(
  event: EmailReceivedEvent,
  config: ExpenseEmailProviderConfig,
  providerEventId: string
): Promise<ExpenseEmailProcessSummary> {
  const summary: ExpenseEmailProcessSummary = { stored: 0, duplicate: 0, ignored: 0 };
  const recipients = [
    ...(event.data.received_for ?? []),
    ...(event.data.to ?? []),
    ...(event.data.cc ?? []),
    ...(event.data.bcc ?? []),
  ];
  const aliasToken = resolveSingleExpenseAliasToken(recipients, config.receivingDomain);
  if (!aliasToken) return { ...summary, ignored: event.data.attachments.length || 1 };

  const alias = await resolveAlias(aliasToken);
  if (!alias) return { ...summary, ignored: event.data.attachments.length || 1 };

  const supportedWebhookAttachments = event.data.attachments.filter(isSupportedExpenseEmailAttachment);
  const reservedSlots = Math.min(supportedWebhookAttachments.length, MAX_ATTACHMENTS_PER_EMAIL);
  summary.ignored += event.data.attachments.length - reservedSlots;

  const claim = await claimExpenseEmailEvent({
    actorId: alias.userId,
    companyId: alias.companyId,
    providerEventId,
    providerEmailId: event.data.email_id,
    reservedSlots,
  });
  if (claim.result === "COMPLETED") {
    return reservedSlots === 0
      ? { ...summary, ignored: summary.ignored || 1 }
      : { ...summary, duplicate: reservedSlots };
  }
  if (claim.result === "RATE_LIMITED") {
    return { ...summary, ignored: Math.max(1, summary.ignored + reservedSlots) };
  }
  if (claim.result === "IN_PROGRESS") throw new Error("El evento ya se está procesando.");
  if (!claim.claimToken) throw new Error("El reclamo no devolvió token de intento.");

  try {
    if (reservedSlots === 0) {
      await completeExpenseEmailEvent(alias.userId, alias.companyId, event.data.email_id, claim.claimToken);
      return { ...summary, ignored: summary.ignored || 1 };
    }

    const resend = new Resend(config.apiKey);
    const { data, error } = await resend.emails.receiving.attachments.list({ emailId: event.data.email_id });
    if (error || !data) throw new Error("No se pudo consultar la lista de adjuntos.");

    const eligibleIds = new Set(supportedWebhookAttachments.map((attachment) => attachment.id));
    const processable = selectProcessableExpenseEmailAttachments(
      data.data.filter((attachment) => eligibleIds.has(attachment.id)
        && attachment.size > 0
        && attachment.size <= EXPENSE_RECEIPT_MAX_BYTES
        && isTrustedResendAttachmentUrl(attachment.download_url))
    );
    summary.ignored += Math.max(0, reservedSlots - processable.length);

    if (processable.length > 0) {
      const bytesAllowed = await reserveExpenseEmailBytes({
        actorId: alias.userId,
        companyId: alias.companyId,
        providerEmailId: event.data.email_id,
        claimToken: claim.claimToken,
        reservedBytes: processable.reduce((total, attachment) => total + attachment.size, 0),
      });
      if (!bytesAllowed) {
        return { ...summary, ignored: summary.ignored + processable.length };
      }
    }

    for (const listedAttachment of processable) {
      const downloaded = await downloadWithFreshUrl(resend, event.data.email_id, listedAttachment);
      if (!downloaded.bytes) {
        summary.ignored += 1;
        continue;
      }

      const declaredMime = normalizedMime(downloaded.attachment.content_type);
      const candidate = new File(
        [downloaded.bytes],
        downloaded.attachment.filename ?? "comprobante",
        { type: declaredMime }
      );
      const validation = await validateExpenseReceiptFile(candidate);
      if (!validation.ok || !validation.mimeType || !validation.extension) {
        summary.ignored += 1;
        continue;
      }

      const stored = await storeInboundExpenseCapture({
        actorId: alias.userId,
        companyId: alias.companyId,
        source: "EMAIL",
        providerEmailId: event.data.email_id,
        claimToken: claim.claimToken,
        externalMessageId: `resend:${createHash("sha256")
          .update(`${event.data.email_id}:${downloaded.attachment.id}`)
          .digest("hex")}`,
        originalFilename: safeAttachmentFilename(downloaded.attachment.filename, validation.extension),
        mimeType: validation.mimeType,
        extension: validation.extension,
        bytes: downloaded.bytes,
      });
      if (!stored.ok) throw new Error("No se pudo almacenar un comprobante recibido.");
      if (stored.duplicate) summary.duplicate += 1;
      else summary.stored += 1;
    }

    await completeExpenseEmailEvent(alias.userId, alias.companyId, event.data.email_id, claim.claimToken);
    return summary;
  } catch (error) {
    try {
      await releaseExpenseEmailEvent(alias.userId, alias.companyId, event.data.email_id, claim.claimToken);
    } catch {
      // La lease expira sola; no ocultamos la causa original del reintento.
    }
    throw error;
  }
}
