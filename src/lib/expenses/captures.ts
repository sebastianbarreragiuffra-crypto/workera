import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { ExpenseCompanyContext } from "@/lib/expenses/access";
import { isExpenseFileReleased } from "@/lib/expenses/file-security";

export interface ExpenseReceiptCaptureDto {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  source: "WEB_UPLOAD" | "WEB_CAMERA" | "EMAIL" | "WHATSAPP";
  createdAt: string;
  possibleDuplicate: boolean;
  securityStatus: Database["public"]["Enums"]["expense_file_security_status"];
  available: boolean;
}

export interface ExpenseDraftItemOption {
  id: string;
  reportId: string;
  reportLabel: string;
  itemLabel: string;
}

type DraftItem = {
  id: string;
  description: string;
  expense_date: string;
  net_amount: number;
  currency_code: string;
};

function embeddedItems(value: DraftItem | DraftItem[] | null): DraftItem[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function getExpenseReceiptInbox(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<{ captures: ExpenseReceiptCaptureDto[]; draftItems: ExpenseDraftItemOption[] }> {
  const [captureResult, reportResult] = await Promise.all([
    supabase
      .from("expense_receipt_captures")
      .select("id, original_filename, mime_type, file_size, source, checksum_sha256, security_status, created_at")
      .eq("company_id", context.id)
      .eq("uploaded_by", context.userId)
      .eq("status", "PENDING")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("expense_reports")
      .select("id, reference_number, title, expense_items(id, description, expense_date, net_amount, currency_code)")
      .eq("company_id", context.id)
      .eq("submitted_by", context.userId)
      .eq("status", "DRAFT")
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);
  if (captureResult.error || reportResult.error) throw new Error("No pudimos cargar tu bandeja de comprobantes.");

  const rawCaptures = captureResult.data ?? [];
  const checksums = [...new Set(rawCaptures.map((capture) => capture.checksum_sha256))];
  const receiptResult = checksums.length === 0
    ? { data: [], error: null }
    : await supabase
      .from("expense_receipts")
      .select("checksum_sha256")
      .eq("company_id", context.id)
      .in("checksum_sha256", checksums)
      .limit(50);
  if (receiptResult.error) throw new Error("No pudimos verificar comprobantes repetidos.");

  const pendingCounts = new Map<string, number>();
  for (const capture of rawCaptures) {
    pendingCounts.set(capture.checksum_sha256, (pendingCounts.get(capture.checksum_sha256) ?? 0) + 1);
  }
  const registeredChecksums = new Set((receiptResult.data ?? []).map((receipt) => receipt.checksum_sha256));

  return {
    captures: rawCaptures.map((capture) => ({
      id: capture.id,
      originalFilename: capture.original_filename,
      mimeType: capture.mime_type,
      fileSize: capture.file_size,
      source: capture.source as ExpenseReceiptCaptureDto["source"],
      createdAt: capture.created_at,
      possibleDuplicate: (pendingCounts.get(capture.checksum_sha256) ?? 0) > 1
        || registeredChecksums.has(capture.checksum_sha256),
      securityStatus: capture.security_status,
      available: isExpenseFileReleased(capture.security_status),
    })),
    draftItems: (reportResult.data ?? []).flatMap((report) =>
      embeddedItems(report.expense_items).map((item) => ({
        id: item.id,
        reportId: report.id,
        reportLabel: `${report.reference_number} · ${report.title}`,
        itemLabel: `${item.expense_date} · ${item.description} · ${new Intl.NumberFormat("es-CL", {
          style: "currency",
          currency: item.currency_code,
          maximumFractionDigits: item.currency_code === "CLP" ? 0 : 2,
        }).format(item.net_amount)}`,
      }))
    ),
  };
}
