"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
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

  const { data: policy } = await supabase
    .from("expense_policies")
    .select("id")
    .eq("company_id", context.id)
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("expense_reports")
    .insert({
      company_id: context.id,
      submitted_by: context.userId,
      title: parsed.data.title,
      purpose: parsed.data.purpose,
      currency_code: parsed.data.currencyCode,
      policy_id: policy?.id ?? null,
    })
    .select("id")
    .single();

  if (error || !data) return failed("No pudimos crear la rendición. Intenta nuevamente.");
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  redirect(reportPath(context.slug, data.id));
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
  if (error?.code === "23514") return failed("Agrega al menos un gasto válido antes de enviarla, o verifica que siga en borrador.");
  if (error) return failed("No pudimos enviar la rendición a revisión.");

  revalidatePath(reportPath(context.slug, parsed.data.reportId));
  revalidatePath(`/empresas/${context.slug}/rendiciones`);
  redirect(`/empresas/${context.slug}/rendiciones?enviada=1`);
}
