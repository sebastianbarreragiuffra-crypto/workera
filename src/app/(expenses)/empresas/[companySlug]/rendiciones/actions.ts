"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { getExpenseSpecialRates } from "@/lib/expenses/data";
import { validateExpenseReceiptFile } from "@/lib/expenses/receipts";
import { getExpenseEmailDomain } from "@/lib/expense-email/config";
import { getExpenseWhatsappProviderConfig, whatsappLink } from "@/lib/expense-whatsapp/config";
import { discardExpenseCapture, storeExpenseCapture, storeExpenseReceipt } from "@/lib/expense-capture/service";
import { runExpenseOcrWorkerWithServiceRole } from "@/lib/expense-ocr/service";
import { createClient } from "@/lib/supabase/server";
import { unwrapEmbed } from "@/lib/supabase/embed";
import type { Json } from "@/lib/supabase/database.types";

export interface ExpenseActionState {
  status: "idle" | "success" | "error";
  message: string;
  pairingCode?: string;
  pairingUrl?: string;
}

/**
 * Da una primera oportunidad de procesamiento apenas se adjunta el archivo,
 * sin hacer esperar al teléfono. La cola PostgreSQL sigue siendo la fuente de
 * verdad: si esta ejecución best-effort se corta, el cron diario retoma el job.
 */
function kickExpenseOcrAfterResponse(): void {
  if (process.env.EXPENSE_OCR_ENABLED !== "true") return;
  after(async () => {
    try {
      await runExpenseOcrWorkerWithServiceRole();
    } catch {
      console.error("[expense-ocr] el disparo posterior a la respuesta no pudo completar la cola");
    }
  });
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
  // Topes alineados con distance_km/per_diem_days numeric(10,2)/(6,2):
  // nunca dejar que la validación real de rango la haga recién la base de
  // datos.
  distanceKm: z.string().optional().transform((value) => (value && value.trim() !== "" ? Number(value) : null))
    .refine((value) => value === null || (Number.isFinite(value) && value > 0 && value <= 100000), "Kilómetros inválidos"),
  perDiemDays: z.string().optional().transform((value) => (value && value.trim() !== "" ? Number(value) : null))
    .refine((value) => value === null || (Number.isFinite(value) && value > 0 && value <= 9999), "Días de viático inválidos"),
});
const reportActionInput = z.object({ companySlug: slug, reportId: uuid });
const policyLimitsInput = z.object({ companySlug: slug, policyId: uuid });
const itemActionInput = reportActionInput.extend({ itemId: uuid });
const captureUploadInput = z.object({
  companySlug: slug,
  source: z.enum(["WEB_UPLOAD", "WEB_CAMERA"]),
});
const captureActionInput = z.object({ companySlug: slug, captureId: uuid });
const attachCaptureInput = captureActionInput.extend({ itemId: uuid });
const emailAliasInput = z.object({ companySlug: slug, intent: z.enum(["ensure", "rotate"]) });
const whatsappLinkInput = z.object({ companySlug: slug, intent: z.enum(["pair", "disconnect"]) });
const reconcileInput = reportActionInput.extend({
  paymentReference: z.string().trim().min(1).max(160),
});
const bankTransactionInput = z.object({ companySlug: slug, transactionId: uuid });
const bankMatchInput = bankTransactionInput.extend({ reportId: uuid });
const bankIgnoreInput = bankTransactionInput.extend({ reason: z.string().trim().min(3).max(240) });
const decisionInput = reportActionInput.extend({
  decision: z.enum(["APPROVED", "REJECTED", "RETURNED"]),
  comment: z.string().trim().max(1000).transform((value) => value || null),
});
const grantAdvanceInput = z.object({
  companySlug: slug,
  recipientId: uuid,
  amount: z.coerce.number().finite().positive().max(999999999999.99),
  currencyCode: z.enum(["CLP", "USD", "EUR"]),
  purpose: z.string().trim().min(2).max(240),
});
const advanceActionInput = z.object({ companySlug: slug, advanceId: uuid });
const linkAdvanceInput = reportActionInput.extend({
  advanceId: z.string().transform((value) => value || null).pipe(z.uuid().nullable()),
});
const costCenterInput = reportActionInput.extend({
  organizationUnitId: z.string().transform((value) => value || null).pipe(z.uuid().nullable()),
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
    p_purpose: parsed.data.purpose ?? null,
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
  if (parsed.data.distanceKm !== null && parsed.data.perDiemDays !== null) {
    return failed("Un gasto no puede ser kilometraje y viático a la vez.");
  }

  // Kilometraje/viático (EX-8): el monto NUNCA se confía del cliente para
  // estos casos -- se recalcula acá desde la tarifa vigente de la
  // política, igual que cualquier otro dato que determina cuánto se le
  // paga a alguien.
  let netAmount = parsed.data.netAmount;
  const isSpecialRate = parsed.data.distanceKm !== null || parsed.data.perDiemDays !== null;
  if (isSpecialRate) {
    const rates = await getExpenseSpecialRates(supabase, context);
    if (parsed.data.distanceKm !== null) {
      if (!rates.mileageRatePerKm) return failed("Configura la tarifa por kilómetro en Políticas antes de cargar un gasto de kilometraje.");
      netAmount = Math.round(parsed.data.distanceKm * rates.mileageRatePerKm * 100) / 100;
    } else if (parsed.data.perDiemDays !== null) {
      if (!rates.perDiemDailyRate) return failed("Configura la tarifa diaria de viático en Políticas antes de cargar un gasto de viático.");
      netAmount = Math.round(parsed.data.perDiemDays * rates.perDiemDailyRate * 100) / 100;
    }
  }

  const { error } = await supabase.from("expense_items").insert({
    company_id: context.id,
    report_id: report.id,
    category_id: parsed.data.categoryId,
    expense_date: parsed.data.expenseDate,
    merchant_name: parsed.data.merchantName,
    description: parsed.data.description,
    net_amount: netAmount,
    tax_amount: isSpecialRate ? 0 : parsed.data.taxAmount,
    currency_code: parsed.data.currencyCode,
    distance_km: parsed.data.distanceKm,
    per_diem_days: parsed.data.perDiemDays,
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
  if (error?.code === "23514" && error.message.includes("monto máximo")) return failed("Un gasto supera el monto máximo permitido para su categoría. Reduce el monto o divídelo antes de enviar.");
  if (error?.code === "23514") return failed("Agrega al menos un gasto válido antes de enviarla, o verifica que siga en borrador.");
  if (error) return failed("No pudimos enviar la rendición a revisión.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  redirect(`/empresas/${context.slug}/rendiciones?enviada=1`);
}

export async function withdrawExpenseReportAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = reportActionInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context) return failed("No tienes acceso a esta rendición.");

  const { error } = await supabase.rpc("withdraw_expense_report", { p_report_id: parsed.data.reportId });
  if (error?.code === "23514") return failed("Solo se puede retirar una rendición pendiente de revisión.");
  if (error?.code === "42501") return failed("No puedes retirar esta rendición.");
  if (error) return failed("No pudimos retirar la rendición.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  return { status: "success", message: "Rendición retirada -- vuelve a estar en borrador para que la corrijas." };
}

export async function updateCategoryLimitsAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = policyLimitsInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canConfigure && !context?.canManage) return failed("Tu rol no permite configurar políticas de gasto.");

  const rawLimits = new Map<string, string>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("limit_") || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    rawLimits.set(key.slice("limit_".length), trimmed);
  }

  const categoryLimits: Record<string, number> = {};
  if (rawLimits.size > 0) {
    const { data: categories, error: categoriesError } = await supabase
      .from("expense_categories")
      .select("id")
      .eq("company_id", context.id)
      .in("id", [...rawLimits.keys()]);
    if (categoriesError) return failed("No se pudieron validar las categorías.");
    const validIds = new Set((categories ?? []).map((category) => category.id));

    for (const [categoryId, trimmed] of rawLimits) {
      if (!validIds.has(categoryId)) return failed("Una de las categorías enviadas no pertenece a esta empresa.");
      const amount = Number(trimmed);
      if (!Number.isFinite(amount) || amount <= 0) return failed("Los montos máximos deben ser números enteros positivos.");
      categoryLimits[categoryId] = Math.round(amount);
    }
  }

  const thresholdRaw = formData.get("secondApproverThreshold");
  let secondApproverThreshold: number | null = null;
  if (typeof thresholdRaw === "string" && thresholdRaw.trim() !== "") {
    const amount = Number(thresholdRaw.trim());
    if (!Number.isFinite(amount) || amount <= 0) return failed("El monto que exige un segundo aprobador debe ser un número positivo.");
    secondApproverThreshold = Math.round(amount);
  }

  // rules guarda otros campos (receipt_required_from, etc.) -- se fusiona en
  // vez de reemplazar todo el objeto para no pisarlos.
  const { data: current, error: readError } = await supabase
    .from("expense_policies")
    .select("rules")
    .eq("company_id", context.id)
    .eq("id", parsed.data.policyId)
    .single();
  if (readError || !current) return failed("No se pudo leer la política vigente.");

  // Mismo tope que netAmount/taxAmount (999999999999.99): una tarifa mal
  // tipeada (un cero de más) se atrapa acá, con un mensaje claro, en vez de
  // dejar que se guarde y recién falle -- genérico y confuso -- el día que
  // alguien cargue un gasto real contra ella.
  const rateMax = 999999999999.99;
  function parsePositiveRate(raw: FormDataEntryValue | null): number | null {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const amount = Number(raw.trim());
    if (!Number.isFinite(amount) || amount <= 0 || amount > rateMax) return null;
    return Math.round(amount);
  }

  const mileageRateRaw = formData.get("mileageRatePerKm");
  let mileageRatePerKm: number | null = null;
  if (typeof mileageRateRaw === "string" && mileageRateRaw.trim() !== "") {
    mileageRatePerKm = parsePositiveRate(mileageRateRaw);
    if (mileageRatePerKm === null) return failed("La tarifa por kilómetro debe ser un número positivo válido.");
  }

  const perDiemRateRaw = formData.get("perDiemDailyRate");
  let perDiemDailyRate: number | null = null;
  if (typeof perDiemRateRaw === "string" && perDiemRateRaw.trim() !== "") {
    perDiemDailyRate = parsePositiveRate(perDiemRateRaw);
    if (perDiemDailyRate === null) return failed("La tarifa diaria de viático debe ser un número positivo válido.");
  }

  const nextRules: Record<string, unknown> = { ...(current.rules as Record<string, unknown>), categoryLimits };
  if (secondApproverThreshold === null) delete nextRules.secondApproverThreshold;
  else nextRules.secondApproverThreshold = secondApproverThreshold;
  if (mileageRatePerKm === null) delete nextRules.mileageRatePerKm;
  else nextRules.mileageRatePerKm = mileageRatePerKm;
  if (perDiemDailyRate === null) delete nextRules.perDiemDailyRate;
  else nextRules.perDiemDailyRate = perDiemDailyRate;
  const rules = nextRules as unknown as Json;

  const { error } = await supabase
    .from("expense_policies")
    .update({ rules })
    .eq("company_id", context.id)
    .eq("id", parsed.data.policyId);
  if (error) return failed("No pudimos guardar la política.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/politicas`);
  return { status: "success", message: "Política actualizada -- los límites se aplican desde el próximo envío." };
}

export async function reconcileExpenseReportAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = reconcileInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Indica una referencia de pago o asiento contable.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return failed("Tu rol no permite conciliar rendiciones.");

  const { error } = await supabase.rpc("reconcile_expense_report", {
    p_report_id: parsed.data.reportId,
    p_payment_reference: parsed.data.paymentReference,
  });
  if (error?.code === "23514") return failed("Solo se puede conciliar una rendición aprobada, con una referencia de pago.");
  if (error?.code === "42501") return failed("Tu rol no permite conciliar esta rendición.");
  if (error) return failed("No pudimos registrar la conciliación.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  revalidatePath(`/empresas/${context.slug}/rendiciones/conciliacion`);
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  return { status: "success", message: "Rendición conciliada -- queda registrada como pagada." };
}

export async function matchExpenseBankTransactionAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = bankMatchInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Selecciona una rendición válida.");
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return failed("Tu rol no permite conciliar movimientos.");

  const { data: transaction } = await supabase
    .from("expense_bank_transactions")
    .select("id")
    .eq("company_id", context.id)
    .eq("id", parsed.data.transactionId)
    .eq("status", "UNMATCHED")
    .maybeSingle();
  if (!transaction) return failed("El movimiento ya no está disponible en esta empresa.");

  const { error } = await supabase.rpc("match_expense_bank_transaction", {
    p_transaction_id: parsed.data.transactionId,
    p_report_id: parsed.data.reportId,
    p_method: "SUGGESTED",
  });
  if (error?.code === "23514") return failed("El pago ya fue usado, o la rendición cambió y dejó de coincidir.");
  if (error?.code === "23503") return failed("El movimiento o la rendición ya no están disponibles.");
  if (error) return failed("No pudimos confirmar la conciliación.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/conciliacion`);
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  return { status: "success", message: "Movimiento conciliado y rendición marcada como pagada." };
}

export async function ignoreExpenseBankTransactionAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = bankIgnoreInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Indica un motivo de al menos 3 caracteres.");
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return failed("Tu rol no permite resolver movimientos.");

  const { data: transaction } = await supabase
    .from("expense_bank_transactions")
    .select("id")
    .eq("company_id", context.id)
    .eq("id", parsed.data.transactionId)
    .eq("status", "UNMATCHED")
    .maybeSingle();
  if (!transaction) return failed("El movimiento ya no está disponible en esta empresa.");

  const { error } = await supabase.rpc("ignore_expense_bank_transaction", {
    p_transaction_id: parsed.data.transactionId,
    p_reason: parsed.data.reason,
  });
  if (error?.code === "23514") return failed("El movimiento ya fue resuelto o el motivo no es válido.");
  if (error) return failed("No pudimos ignorar el movimiento.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/conciliacion`);
  return { status: "success", message: "Movimiento apartado con motivo y trazabilidad." };
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
  const relatedReport = unwrapEmbed(item?.expense_reports);
  if (!item || !relatedReport || relatedReport.status !== "DRAFT" || (relatedReport.submitted_by !== context.userId && !context.canManage)) {
    return failed("El gasto ya no está disponible para adjuntar comprobantes.");
  }

  const stored = await storeExpenseReceipt({
    actorId: context.userId,
    companyId: context.id,
    reportId: parsed.data.reportId,
    itemId: parsed.data.itemId,
    originalFilename: file.name.slice(0, 240) || `comprobante.${validation.extension}`,
    mimeType: validation.mimeType,
    extension: validation.extension,
    bytes: await file.arrayBuffer(),
  });
  if (!stored.ok && stored.reason === "STORAGE") return failed("No pudimos guardar el comprobante en el almacenamiento privado.");
  if (!stored.ok) return failed("No pudimos asociar el comprobante al gasto. Intenta nuevamente.");

  kickExpenseOcrAfterResponse();
  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  return { status: "success", message: "Comprobante adjuntado de forma privada." };
}

export async function captureExpenseReceiptAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = captureUploadInput.safeParse(entries(formData));
  const file = formData.get("receipt");
  if (!parsed.success || !(file instanceof File)) return failed("Selecciona un comprobante válido.");

  const validation = await validateExpenseReceiptFile(file);
  if (!validation.ok || !validation.mimeType || !validation.extension) return failed(validation.message);
  if (parsed.data.source === "WEB_CAMERA" && !validation.mimeType.startsWith("image/")) {
    return failed("La captura de cámara debe ser una imagen JPG o PNG.");
  }

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite capturar comprobantes.");

  // Evita transferir y hashear hasta 10 MB cuando la bandeja ya está llena.
  // El RPC repite el control bajo advisory lock porque este pre-chequeo solo
  // optimiza recursos; la base sigue siendo la autoridad ante concurrencia.
  const { count: pendingCount, error: pendingError } = await supabase
    .from("expense_receipt_captures")
    .select("id", { count: "exact", head: true })
    .eq("company_id", context.id)
    .eq("uploaded_by", context.userId)
    .eq("status", "PENDING");
  if (pendingError) return failed("No pudimos verificar tu bandeja de comprobantes.");
  if ((pendingCount ?? 0) >= 50) return failed("Tu bandeja alcanzó el máximo de 50 comprobantes pendientes.");

  const stored = await storeExpenseCapture({
    actorId: context.userId,
    companyId: context.id,
    source: parsed.data.source,
    originalFilename: file.name.slice(0, 240) || `comprobante.${validation.extension}`,
    mimeType: validation.mimeType,
    extension: validation.extension,
    bytes: await file.arrayBuffer(),
  });
  if (!stored.ok && stored.reason === "LIMIT") return failed("Tu bandeja alcanzó el máximo de 50 comprobantes pendientes.");
  if (!stored.ok && stored.reason === "STORAGE") return failed("No pudimos guardar el comprobante en el almacenamiento privado.");
  if (!stored.ok) return failed("No pudimos registrar el comprobante. Intenta nuevamente.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/comprobantes`);
  return { status: "success", message: "Comprobante guardado en tu bandeja privada." };
}

export async function configureExpenseReceiptEmailAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = emailAliasInput.safeParse(entries(formData));
  if (!parsed.success) return failed("No pudimos configurar la dirección de correo.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite recibir comprobantes.");
  if (!getExpenseEmailDomain()) {
    return failed("El dominio de recepción todavía no está configurado.");
  }

  const rpc = parsed.data.intent === "rotate"
    ? "rotate_expense_receipt_email_alias"
    : "ensure_expense_receipt_email_alias";
  const { error } = await supabase.rpc(rpc, { p_company_id: context.id });
  if (error?.code === "42501") return failed("Tu acceso a Rendiciones cambió. Actualiza la página.");
  if (error) return failed("No pudimos configurar la dirección de correo.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/comprobantes`);
  return {
    status: "success",
    message: parsed.data.intent === "rotate"
      ? "Dirección reemplazada. La anterior dejó de recibir comprobantes."
      : "Dirección de recepción activada.",
  };
}

export async function configureExpenseReceiptWhatsappAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = whatsappLinkInput.safeParse(entries(formData));
  if (!parsed.success) return failed("No pudimos configurar WhatsApp.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite recibir comprobantes.");

  if (parsed.data.intent === "disconnect") {
    const { error } = await supabase.rpc("disconnect_expense_receipt_whatsapp", { p_company_id: context.id });
    if (error) return failed("No pudimos desvincular WhatsApp.");
    revalidatePath(`/empresas/${context.slug}/rendiciones/comprobantes`);
    return { status: "success", message: "WhatsApp quedó desvinculado de esta empresa." };
  }

  const config = getExpenseWhatsappProviderConfig();
  if (!config?.enabled) return failed("La recepción por WhatsApp todavía no está habilitada.");

  const compactCode = randomBytes(12).toString("hex").toUpperCase();
  const pairingCode = compactCode.match(/.{1,4}/g)?.join("-") ?? compactCode;
  const tokenHash = createHash("sha256").update(compactCode).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error } = await supabase.rpc("begin_expense_receipt_whatsapp_pairing", {
    p_company_id: context.id,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
  });
  if (error?.code === "42501") return failed("Tu acceso a Rendiciones cambió. Actualiza la página.");
  if (error) return failed("No pudimos crear el código de vinculación.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/comprobantes`);
  return {
    status: "success",
    message: "Código creado. Envíalo dentro de 10 minutos desde tu WhatsApp.",
    pairingCode,
    pairingUrl: whatsappLink(config.businessNumber, pairingCode),
  };
}

export async function attachExpenseReceiptCaptureAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = attachCaptureInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Selecciona un gasto válido.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite adjuntar comprobantes.");

  const { data: receiptId, error } = await supabase.rpc("attach_expense_receipt_capture", {
    p_capture_id: parsed.data.captureId,
    p_item_id: parsed.data.itemId,
  });
  if (error || !receiptId) {
    if (error?.code === "23514") return failed("El comprobante o el gasto ya no están disponibles.");
    if (error?.code === "42501") return failed("No puedes asociar este comprobante al gasto seleccionado.");
    return failed("No pudimos asociar el comprobante. Intenta nuevamente.");
  }

  kickExpenseOcrAfterResponse();
  revalidatePath(`/empresas/${context.slug}/rendiciones/comprobantes`);
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  return { status: "success", message: "Comprobante asociado al gasto y enviado a procesamiento." };
}

export async function discardExpenseReceiptCaptureAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = captureActionInput.safeParse(entries(formData));
  if (!parsed.success) return failed("El comprobante ya no está disponible.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canSubmit) return failed("Tu rol no permite descartar comprobantes.");

  const discarded = await discardExpenseCapture({
    actorId: context.userId,
    companyId: context.id,
    captureId: parsed.data.captureId,
  });
  if (!discarded) return failed("El comprobante ya no está disponible.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/comprobantes`);
  return { status: "success", message: "Comprobante descartado de tu bandeja." };
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
  if (error?.code === "42501" && error.message.includes("ronda")) return failed("Ya registraste una decisión para esta rendición; otra persona debe resolver el siguiente paso.");
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

export async function grantExpenseAdvanceAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = grantAdvanceInput.safeParse(entries(formData));
  if (!parsed.success) return failed("Revisa la persona destinataria, el monto y el motivo del anticipo.");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return failed("Tu rol no permite otorgar anticipos.");

  const { error } = await supabase.rpc("grant_expense_advance", {
    p_company_id: context.id,
    p_recipient_id: parsed.data.recipientId,
    p_amount: parsed.data.amount,
    p_currency_code: parsed.data.currencyCode,
    p_purpose: parsed.data.purpose,
  });
  if (error?.code === "23503") return failed("La persona destinataria no es miembro activo de esta empresa.");
  if (error) return failed("No pudimos otorgar el anticipo.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/anticipos`);
  return { status: "success", message: "Anticipo otorgado correctamente." };
}

export async function settleExpenseAdvanceAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = advanceActionInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return failed("Tu rol no permite cerrar anticipos.");

  const { error } = await supabase.rpc("settle_expense_advance", { p_advance_id: parsed.data.advanceId });
  if (error?.code === "23514") return failed("Solo se puede cerrar un anticipo pendiente.");
  if (error) return failed("No pudimos cerrar el anticipo.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/anticipos`);
  return { status: "success", message: "Anticipo cerrado." };
}

export async function cancelExpenseAdvanceAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = advanceActionInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return failed("Tu rol no permite cancelar anticipos.");

  const { error } = await supabase.rpc("cancel_expense_advance", { p_advance_id: parsed.data.advanceId });
  if (error?.code === "23514") return failed("Este anticipo ya tiene rendiciones vinculadas -- ciérralo en vez de cancelarlo.");
  if (error) return failed("No pudimos cancelar el anticipo.");

  revalidatePath(`/empresas/${context.slug}/rendiciones/anticipos`);
  return { status: "success", message: "Anticipo cancelado." };
}

export async function linkExpenseReportToAdvanceAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = linkAdvanceInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context) return failed("No tienes acceso a esta rendición.");

  const { error } = await supabase.rpc("link_expense_report_to_advance", {
    p_report_id: parsed.data.reportId,
    p_advance_id: parsed.data.advanceId,
  });
  if (error?.code === "23514") return failed("Ese anticipo ya no está disponible para vincular, o la rendición ya no admite cambios.");
  if (error?.code === "42501") return failed("No puedes vincular ese anticipo.");
  if (error) return failed("No pudimos actualizar el anticipo vinculado.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  return { status: "success", message: parsed.data.advanceId ? "Anticipo vinculado." : "Anticipo desvinculado." };
}

export async function updateExpenseReportCostCenterAction(
  _previousState: ExpenseActionState,
  formData: FormData
): Promise<ExpenseActionState> {
  const parsed = costCenterInput.safeParse(entries(formData));
  if (!parsed.success) return failed();

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context) return failed("No tienes acceso a esta rendición.");

  // RLS (expense_reports_update_draft) ya exige status='DRAFT' y
  // (submitted_by = auth.uid() o expenses.manage); un UPDATE que no
  // encuentre fila (permiso insuficiente o ya no está en borrador) no
  // lanza error de RLS, simplemente afecta 0 filas -- se detecta explícito
  // para no reportar éxito falso.
  const { data, error } = await supabase
    .from("expense_reports")
    .update({ organization_unit_id: parsed.data.organizationUnitId })
    .eq("company_id", context.id)
    .eq("id", parsed.data.reportId)
    .select("id")
    .maybeSingle();
  if (error?.code === "23503") return failed("Ese centro de costo no pertenece a esta empresa.");
  if (error) return failed("No pudimos actualizar el centro de costo.");
  if (!data) return failed("La rendición ya no está disponible para edición.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  return { status: "success", message: "Centro de costo actualizado." };
}
