"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { validateExpenseReceiptFile } from "@/lib/expenses/receipts";
import { createClient } from "@/lib/supabase/server";

export interface ExpenseActionState {
  status: "idle" | "success" | "error";
  message: string;
}

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63);
const uuid = z.string().uuid();
const createReportInput = z.object({
  companySlug: slug,
  title: z.string().trim().min(2).max(160),
  purpose: z.string().trim().max(1000).transform((value) => value || null),
  currencyCode: z.enum(["CLP", "USD", "EUR"]),
  clientRequestId: uuid,
});
const addItemInput = z.object({
  companySlug: slug,
  reportId: uuid,
  categoryId: z.string().transform((value) => value || null).pipe(z.uuid().nullable()),
  expenseDate: z.iso.date(),
  merchantName: z.string().trim().max(160).transform((value) => value || null),
  description: z.string().trim().min(2).max(240),
  netAmount: z.coerce.number().finite().positive().max(999999999999.99),
  taxAmount: z.coerce.number().finite().min(0).max(999999999999.99),
  currencyCode: z.enum(["CLP", "USD", "EUR"]),
});
const reportActionInput = z.object({ companySlug: slug, reportId: uuid });
const itemActionInput = reportActionInput.extend({ itemId: uuid });
const decisionInput = reportActionInput.extend({
  decision: z.enum(["APPROVED", "REJECTED", "RETURNED"]),
  comment: z.string().trim().max(1000).transform((value) => value || null),
});
const ocrReviewInput = reportActionInput.extend({
  receiptId: uuid,
  decision: z.enum(["ACCEPTED", "REJECTED"]),
  comment: z.string().trim().max(1000).transform((value) => value || null),
});

function entries(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

function failed(message = "Revisa los datos e intenta nuevamente."): ExpenseActionState {
  return { status: "error", message };
}

function reportPath(companySlug: string, reportId: string): string {
  return `/empresas/${companySlug}/rendiciones/${reportId}`;
}

export async function createExpenseReportAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = createReportInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite crear rendiciones en esta empresa.");

  // create_expense_report() es idempotente: un doble clic o un reintento de
  // red que repita el mismo clientRequestId devuelve el borrador ya creado
  // en vez de duplicarlo (ver 20260901210000_expense_reports_idempotent_create.sql).
  const { data: reportId, error } = await supabase.rpc("create_expense_report", {
    p_company_id: context.id,
    p_title: parsed.data.title,
    p_purpose: parsed.data.purpose ?? undefined,
    p_currency_code: parsed.data.currencyCode,
    p_client_request_id: parsed.data.clientRequestId,
  });

  if (error || !reportId) return failed("No pudimos crear la rendición. Intenta nuevamente.");
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  redirect(reportPath(context.slug, reportId));
}

export async function addExpenseItemAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = addItemInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Completa la fecha, descripción y montos válidos.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite modificar esta rendición.");

  const { data: report } = await supabase
    .from("expense_reports")
    .select("id, status, currency_code")
    .eq("company_id", context.id)
    .eq("id", parsed.data.reportId)
    .maybeSingle();
  if (!report || report.status !== "DRAFT") return failed("La rendición ya no está disponible para edición.");
  if (report.currency_code !== parsed.data.currencyCode) return failed("El gasto debe usar la misma moneda de la rendición.");

  const { error } = await supabase.from("expense_items").insert({
    company_id: context.id,
    report_id: report.id,
    category_id: parsed.data.categoryId,
    expense_date: parsed.data.expenseDate,
    merchant_name: parsed.data.merchantName,
    description: parsed.data.description,
    net_amount: parsed.data.netAmount,
    tax_amount: parsed.data.taxAmount,
    currency_code: parsed.data.currencyCode,
  });
  if (error) return failed("No pudimos agregar el gasto. Verifica la categoría y los montos.");

  revalidatePath(reportPath(context.slug, report.id));
  return { status: "success", message: "Gasto agregado correctamente." };
}

export async function deleteExpenseItemAction(formData: FormData): Promise<void> {
  const parsed = itemActionInput.safeParse(entries(formData));
  if (!parsed.success) return;

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return;

  await supabase
    .from("expense_items")
    .delete()
    .eq("company_id", context.id)
    .eq("report_id", parsed.data.reportId)
    .eq("id", parsed.data.itemId);
  revalidatePath(reportPath(context.slug, parsed.data.reportId));
}

export async function submitExpenseReportAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = reportActionInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite enviar esta rendición.");

  const { error } = await supabase.rpc("submit_expense_report", { p_report_id: parsed.data.reportId });
  if (error?.code === "23514" && error.message.includes("comprobantes")) return failed("Adjunta todos los comprobantes obligatorios antes de enviar.");
  if (error?.code === "23514") return failed("Agrega al menos un gasto válido antes de enviarla, o verifica que siga en borrador.");
  if (error) return failed("No pudimos enviar la rendición a revisión.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  redirect(`/empresas/${context.slug}/rendiciones?enviada=1`);
}

export async function uploadExpenseReceiptAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = itemActionInput.safeParse(entries(formData));
  const file = formData.get("receipt");
  if (!parsed.success || !(file instanceof File)) return failed("Selecciona un comprobante válido.");

  const validation = await validateExpenseReceiptFile(file);
  if (!validation.ok || !validation.mimeType || !validation.extension) return failed(validation.message);

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite adjuntar comprobantes.");

  const { data: item } = await supabase
    .from("expense_items")
    .select("id, report_id, expense_reports!inner(status, submitted_by)")
    .eq("company_id", context.id)
    .eq("report_id", parsed.data.reportId)
    .eq("id", parsed.data.itemId)
    .maybeSingle();
  const relatedReport = Array.isArray(item?.expense_reports) ? item.expense_reports[0] : item?.expense_reports;
  if (!item || !relatedReport || relatedReport.status !== "DRAFT" || (relatedReport.submitted_by !== context.userId && !context.canManage)) {
    return failed("El gasto ya no está disponible para adjuntar comprobantes.");
  }

  const bytes = await file.arrayBuffer();
  const checksum = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const objectId = randomUUID();
  const storagePath = `${context.id}/${context.userId}/${parsed.data.reportId}/${parsed.data.itemId}/${objectId}.${validation.extension}`;
  const { error: uploadError } = await supabase.storage.from("expense-receipts").upload(storagePath, bytes, {
    contentType: validation.mimeType,
    cacheControl: "3600",
    upsert: false,
  });
  if (uploadError) return failed("No pudimos guardar el comprobante en el almacenamiento privado.");

  const { error: registerError } = await supabase.rpc("register_expense_receipt", {
    p_item_id: parsed.data.itemId,
    p_storage_path: storagePath,
    p_original_filename: file.name.slice(0, 240) || `comprobante.${validation.extension}`,
    p_mime_type: validation.mimeType,
    p_file_size: file.size,
    p_checksum_sha256: checksum,
  });
  if (registerError) return failed("El archivo se guardó, pero no pudimos asociarlo al gasto. Intenta nuevamente.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  return { status: "success", message: "Comprobante adjuntado de forma privada." };
}

export async function decideExpenseReportAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = decisionInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Revisa la decisión y el comentario.");
  if (parsed.data.decision !== "APPROVED" && !parsed.data.comment) return failed("Explica por qué rechazas o devuelves la rendición.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context || (!context.canApprove && !context.canManage)) return failed("Tu rol no permite decidir rendiciones.");

  const { error } = await supabase.rpc("decide_expense_report", {
    p_report_id: parsed.data.reportId,
    p_decision: parsed.data.decision,
    p_comment: parsed.data.comment ?? undefined,
  });
  if (error?.code === "42501" && error.message.includes("propia")) return failed("Otra persona debe revisar tu propia rendición.");
  if (error?.code === "23514") return failed("La rendición ya no está pendiente o falta el comentario requerido.");
  if (error) return failed("No pudimos registrar la decisión.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  revalidatePath(`/empresas/${context.slug}/rendiciones/aprobaciones`);
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  redirect(`/empresas/${context.slug}/rendiciones/aprobaciones?decidida=1`);
}

export async function reviewExpenseReceiptOcrAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = ocrReviewInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Revisa la decisión y el comentario.");
  if (parsed.data.decision === "REJECTED" && !parsed.data.comment) {
    return failed("Explica por qué rechazas la sugerencia OCR.");
  }

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context) return failed("No tienes acceso a este comprobante.");
  const { error } = await supabase.rpc("review_expense_receipt_extraction", {
    p_receipt_id: parsed.data.receiptId,
    p_decision: parsed.data.decision,
    p_comment: parsed.data.comment ?? undefined,
  });
  if (error?.code === "23514") return failed("La lectura no está disponible o falta el comentario requerido.");
  if (error?.code === "42501") return failed("Tu rol no permite revisar esta sugerencia OCR.");
  if (error) return failed("No pudimos registrar la revisión de la sugerencia OCR.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  return { status: "success", message: "Revisión de la sugerencia OCR registrada." };
}
