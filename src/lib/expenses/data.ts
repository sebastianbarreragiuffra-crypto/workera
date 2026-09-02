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
  receipt: {
    id: string;
    originalFilename: string;
    status: Database["public"]["Enums"]["expense_receipt_status"];
    duplicateOfReceiptId: string | null;
    createdAt: string;
  } | null;
}

export interface ExpenseReportDetail extends ExpenseReportSummary {
  purpose: string | null;
  policyId: string | null;
  reviewRound: number;
  items: ExpenseItemDetail[];
  categories: ExpenseCategoryOption[];
  decisions: Array<{
    id: string;
    stepNumber: number;
    decision: Database["public"]["Enums"]["expense_approval_decision"];
    comment: string | null;
    decidedAt: string;
  }>;
}

export interface ExpenseApprovalQueueItem extends ExpenseReportSummary {
  submitterName: string;
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
  const [reportResult, itemsResult, categoriesResult, receiptsResult, decisionsResult] = await Promise.all([
    supabase
      .from("expense_reports")
      .select("id, reference_number, title, purpose, policy_id, status, currency_code, total_amount, created_at, submitted_at, submitted_by, review_round")
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
    supabase
      .from("expense_receipts")
      .select("id, item_id, original_filename, status, duplicate_of_receipt_id, created_at")
      .eq("company_id", context.id)
      .eq("report_id", reportId)
      .eq("is_current", true),
    supabase
      .from("expense_approval_decisions")
      .select("id, step_number, decision, comment, decided_at")
      .eq("company_id", context.id)
      .eq("report_id", reportId)
      .order("step_number", { ascending: false }),
  ]);

  if (reportResult.error || itemsResult.error || categoriesResult.error || receiptsResult.error || decisionsResult.error) {
    throw new Error("No se pudo cargar el detalle de la rendición.");
  }
  if (!reportResult.data) return null;
  const report = reportResult.data;
  const receiptsByItem = new Map((receiptsResult.data ?? []).map((receipt) => [receipt.item_id, receipt]));

  return {
    id: report.id,
    referenceNumber: report.reference_number,
    title: report.title,
    purpose: report.purpose,
    policyId: report.policy_id,
    reviewRound: report.review_round,
    status: report.status,
    currencyCode: report.currency_code,
    totalAmount: Number(report.total_amount),
    createdAt: report.created_at,
    submittedAt: report.submitted_at,
    isOwn: report.submitted_by === context.userId,
    items: (itemsResult.data ?? []).map((item) => {
      const receipt = receiptsByItem.get(item.id);
      return {
        id: item.id,
        categoryId: item.category_id,
        expenseDate: item.expense_date,
        merchantName: item.merchant_name,
        description: item.description,
        netAmount: Number(item.net_amount),
        taxAmount: Number(item.tax_amount),
        totalAmount: Number(item.total_amount ?? 0),
        receiptStatus: item.receipt_status,
        receipt: receipt ? {
          id: receipt.id,
          originalFilename: receipt.original_filename,
          status: receipt.status,
          duplicateOfReceiptId: receipt.duplicate_of_receipt_id,
          createdAt: receipt.created_at,
        } : null,
      };
    }),
    categories: (categoriesResult.data ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      requiresReceipt: category.requires_receipt,
    })),
    decisions: (decisionsResult.data ?? []).map((decision) => ({
      id: decision.id,
      stepNumber: decision.step_number,
      decision: decision.decision,
      comment: decision.comment,
      decidedAt: decision.decided_at,
    })),
  };
}

export async function getExpenseApprovalQueue(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<ExpenseApprovalQueueItem[]> {
  if (!context.canApprove && !context.canManage) return [];
  const { data, error } = await supabase
    .from("expense_reports")
    .select("id, reference_number, title, status, currency_code, total_amount, created_at, submitted_at, submitted_by, profiles!expense_reports_submitted_by_fkey(display_name)")
    .eq("company_id", context.id)
    .in("status", ["SUBMITTED", "IN_REVIEW"])
    .order("submitted_at", { ascending: true });
  if (error) throw new Error("No se pudo cargar la bandeja de aprobación.");

  return (data ?? []).map((report) => {
    const profile = Array.isArray(report.profiles) ? report.profiles[0] : report.profiles;
    return {
      id: report.id,
      referenceNumber: report.reference_number,
      title: report.title,
      status: report.status,
      currencyCode: report.currency_code,
      totalAmount: Number(report.total_amount),
      createdAt: report.created_at,
      submittedAt: report.submitted_at,
      isOwn: report.submitted_by === context.userId,
      submitterName: profile?.display_name ?? "Persona de la empresa",
    };
  });
}
