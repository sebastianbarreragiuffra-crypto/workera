import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseCompanyContext } from "./access";
import type { Database } from "@/lib/supabase/database.types";

export type ExpenseReportStatus = Database["public"]["Enums"]["expense_report_status"];

export interface ExpenseReportSummary {
  id: string;
  referenceNumber: string;
  title: string;
  status: ExpenseReportStatus;
  currencyCode: string;
  totalAmount: number;
  createdAt: string;
  submittedAt: string | null;
  isOwn: boolean;
}

export interface ExpenseDashboardData {
  reports: ExpenseReportSummary[];
  draftCount: number;
  reviewCount: number;
  approvedCount: number;
  visibleTotal: number;
}

export interface ExpenseCategoryOption {
  id: string;
  name: string;
  requiresReceipt: boolean;
}

export interface ExpenseItemDetail {
  id: string;
  categoryId: string | null;
  expenseDate: string;
  merchantName: string | null;
  description: string;
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
  receiptStatus: Database["public"]["Enums"]["expense_receipt_status"];
}

export interface ExpenseReportDetail extends ExpenseReportSummary {
  purpose: string | null;
  policyId: string | null;
  items: ExpenseItemDetail[];
  categories: ExpenseCategoryOption[];
}

export async function getExpenseDashboard(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<ExpenseDashboardData> {
  const [reportsResult, summaryResult] = await Promise.all([
    supabase
      .from("expense_reports")
      .select("id, reference_number, title, status, currency_code, total_amount, created_at, submitted_at, submitted_by")
      .eq("company_id", context.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.rpc("expense_dashboard_summary", { p_company_id: context.id }).single(),
  ]);
  if (reportsResult.error || summaryResult.error) throw new Error("No se pudieron cargar las rendiciones.");

  const reports = (reportsResult.data ?? []).map((report) => ({
    id: report.id,
    referenceNumber: report.reference_number,
    title: report.title,
    status: report.status,
    currencyCode: report.currency_code,
    totalAmount: Number(report.total_amount),
    createdAt: report.created_at,
    submittedAt: report.submitted_at,
    isOwn: report.submitted_by === context.userId,
  }));

  return {
    reports,
    draftCount: Number(summaryResult.data.draft_count),
    reviewCount: Number(summaryResult.data.review_count),
    approvedCount: Number(summaryResult.data.approved_count),
    visibleTotal: Number(summaryResult.data.visible_total),
  };
}

export async function getExpenseReportDetail(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  reportId: string
): Promise<ExpenseReportDetail | null> {
  const [reportResult, itemsResult, categoriesResult] = await Promise.all([
    supabase
      .from("expense_reports")
      .select("id, reference_number, title, purpose, policy_id, status, currency_code, total_amount, created_at, submitted_at, submitted_by")
      .eq("company_id", context.id)
      .eq("id", reportId)
      .maybeSingle(),
    supabase
      .from("expense_items")
      .select("id, category_id, expense_date, merchant_name, description, net_amount, tax_amount, total_amount, receipt_status")
      .eq("company_id", context.id)
      .eq("report_id", reportId)
      .order("expense_date", { ascending: false }),
    supabase
      .from("expense_categories")
      .select("id, name, requires_receipt")
      .eq("company_id", context.id)
      .eq("active", true)
      .order("name"),
  ]);

  if (reportResult.error || itemsResult.error || categoriesResult.error) {
    throw new Error("No se pudo cargar el detalle de la rendición.");
  }
  if (!reportResult.data) return null;
  const report = reportResult.data;

  return {
    id: report.id,
    referenceNumber: report.reference_number,
    title: report.title,
    purpose: report.purpose,
    policyId: report.policy_id,
    status: report.status,
    currencyCode: report.currency_code,
    totalAmount: Number(report.total_amount),
    createdAt: report.created_at,
    submittedAt: report.submitted_at,
    isOwn: report.submitted_by === context.userId,
    items: (itemsResult.data ?? []).map((item) => ({
      id: item.id,
      categoryId: item.category_id,
      expenseDate: item.expense_date,
      merchantName: item.merchant_name,
      description: item.description,
      netAmount: Number(item.net_amount),
      taxAmount: Number(item.tax_amount),
      totalAmount: Number(item.total_amount ?? 0),
      receiptStatus: item.receipt_status,
    })),
    categories: (categoriesResult.data ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      requiresReceipt: category.requires_receipt,
    })),
  };
}
