import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ExpenseCompanyContext } from "./access";
import type { Database } from "@/lib/supabase/database.types";

export const EXPENSE_ASSISTANT_INTENTS = [
  "ACTION_REQUIRED",
  "SPEND_SUMMARY",
  "PAYMENT_STATUS",
] as const;
export const EXPENSE_ASSISTANT_WINDOWS = [7, 30, 90] as const;

const intentSchema = z.enum(EXPENSE_ASSISTANT_INTENTS);
const windowSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
const reportStatusSchema = z.enum([
  "DRAFT", "SUBMITTED", "IN_REVIEW", "APPROVED", "REJECTED", "PAID", "CANCELLED",
]);
const reasonCodeSchema = z.enum([
  "PENDING_APPROVAL",
  "MISSING_RECEIPT",
  "DUPLICATE_RECEIPT",
  "OCR_REVIEW_PENDING",
  "OCR_FAILED",
  "POLICY_LIMIT_EXCEEDED",
  "APPROVED_IN_WINDOW",
  "PAID_IN_WINDOW",
  "AWAITING_PAYMENT",
  "ACCOUNTING_NOT_QUEUED",
  "ACCOUNTING_PENDING",
  "ACCOUNTING_FAILED",
]);
const generatedAtSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "generatedAt inválido"
);
const citationSchema = z.object({
  reportId: z.string().uuid(),
  referenceNumber: z.string().min(1).max(80),
  status: reportStatusSchema,
  reasonCodes: z.array(reasonCodeSchema).min(1).max(6),
}).strict();
const currencyTotalSchema = z.object({
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  totalAmount: z.number().nonnegative().finite(),
  reportCount: z.number().int().nonnegative(),
}).strict();

const commonShape = {
  schemaVersion: z.literal(1),
  windowDays: windowSchema,
  generatedAt: generatedAtSchema,
  citations: z.array(citationSchema).max(12),
};

const assistantResultSchema = z.discriminatedUnion("intent", [
  z.object({
    ...commonShape,
    intent: z.literal("ACTION_REQUIRED"),
    summary: z.object({
      pendingApprovalReports: z.number().int().nonnegative(),
      missingRequiredReceiptItems: z.number().int().nonnegative(),
      duplicateReceipts: z.number().int().nonnegative(),
      ocrReviewPending: z.number().int().nonnegative(),
      ocrFailures: z.number().int().nonnegative(),
      policyLimitExceededItems: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({
    ...commonShape,
    intent: z.literal("SPEND_SUMMARY"),
    summary: z.object({
      reportCount: z.number().int().nonnegative(),
      approvedReports: z.number().int().nonnegative(),
      paidReports: z.number().int().nonnegative(),
      totals: z.array(currencyTotalSchema).max(20),
    }).strict(),
  }).strict(),
  z.object({
    ...commonShape,
    intent: z.literal("PAYMENT_STATUS"),
    summary: z.object({
      approvedAwaitingPayment: z.number().int().nonnegative(),
      paidInWindow: z.number().int().nonnegative(),
      unmatchedBankTransactions: z.number().int().nonnegative(),
      paidWithoutAccountingExport: z.number().int().nonnegative(),
      accountingInProgress: z.number().int().nonnegative(),
      accountingFailed: z.number().int().nonnegative(),
      awaitingPaymentTotals: z.array(currencyTotalSchema).max(20),
      paidTotals: z.array(currencyTotalSchema).max(20),
    }).strict(),
  }).strict(),
]);

export type ExpenseAssistantIntent = z.infer<typeof intentSchema>;
export type ExpenseAssistantWindow = z.infer<typeof windowSchema>;
export type ExpenseAssistantResult = z.infer<typeof assistantResultSchema>;

export interface ExpenseAssistantQuery {
  id: string;
  intent: ExpenseAssistantIntent;
  windowDays: ExpenseAssistantWindow;
  result: ExpenseAssistantResult;
  citationCount: number;
  createdAt: string;
}

export interface ExpenseAssistantDashboard {
  selected: ExpenseAssistantQuery | null;
  recent: ExpenseAssistantQuery[];
}

export class ExpenseAssistantRateLimitError extends Error {
  constructor() {
    super("Superaste temporalmente el límite de consultas del asistente.");
    this.name = "ExpenseAssistantRateLimitError";
  }
}

type ExpenseAssistantQueryRow = Pick<
  Database["public"]["Tables"]["expense_assistant_queries"]["Row"],
  "id" | "intent" | "window_days" | "result" | "citation_count" | "created_at"
>;

export function canUseExpenseAssistant(context: ExpenseCompanyContext): boolean {
  return context.canReadAll || context.canApprove || context.canReconcile || context.canManage;
}

export function canUseExpenseAssistantIntent(
  context: ExpenseCompanyContext,
  intent: ExpenseAssistantIntent
): boolean {
  if (intent === "PAYMENT_STATUS") return context.canReconcile || context.canManage;
  return context.canReadAll || context.canApprove || context.canManage;
}

export function getAllowedExpenseAssistantIntents(
  context: ExpenseCompanyContext
): ExpenseAssistantIntent[] {
  return EXPENSE_ASSISTANT_INTENTS.filter((intent) => canUseExpenseAssistantIntent(context, intent));
}

export function canOpenExpenseAssistantEvidence(context: ExpenseCompanyContext): boolean {
  return context.canReadAll || context.canApprove || context.canManage;
}

export function parseExpenseAssistantIntent(value: unknown): ExpenseAssistantIntent | null {
  const parsed = intentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseExpenseAssistantWindow(value: unknown): ExpenseAssistantWindow | null {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const parsed = windowSchema.safeParse(numeric);
  return parsed.success ? parsed.data : null;
}

export function parseExpenseAssistantResult(value: unknown): ExpenseAssistantResult {
  const parsed = assistantResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Respuesta inválida del asistente.");
  return parsed.data;
}

function parseQueryRow(
  row: ExpenseAssistantQueryRow
): ExpenseAssistantQuery {
  const result = parseExpenseAssistantResult(row.result);
  if (result.intent !== row.intent || result.windowDays !== row.window_days) {
    throw new Error("Respuesta inválida del asistente.");
  }
  return {
    id: row.id,
    intent: row.intent,
    windowDays: result.windowDays,
    result,
    citationCount: row.citation_count,
    createdAt: row.created_at,
  };
}

export async function runExpenseAssistantQuery(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  intent: ExpenseAssistantIntent,
  windowDays: ExpenseAssistantWindow
): Promise<string> {
  if (!canUseExpenseAssistantIntent(context, intent)) throw new Error("Tu rol no permite usar esta consulta.");
  const parsedIntent = parseExpenseAssistantIntent(intent);
  const parsedWindow = parseExpenseAssistantWindow(windowDays);
  if (!parsedIntent || !parsedWindow) throw new Error("Consulta inválida del asistente.");

  const { data, error } = await supabase.rpc("run_expense_readonly_assistant", {
    p_company_id: context.id,
    p_intent: parsedIntent,
    p_window_days: parsedWindow,
  });
  if (error?.code === "54000") throw new ExpenseAssistantRateLimitError();
  if (error || !data) throw new Error("No se pudo ejecutar el asistente.");
  return data;
}

export async function getExpenseAssistantDashboard(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  selectedQueryId: string | null
): Promise<ExpenseAssistantDashboard | null> {
  if (!canUseExpenseAssistant(context)) return null;

  const fields = "id, intent, window_days, result, citation_count, created_at" as const;
  const recentResult = await supabase
    .from("expense_assistant_queries")
    .select(fields)
    .eq("company_id", context.id)
    .eq("actor_id", context.userId)
    .order("created_at", { ascending: false })
    .limit(8);
  if (recentResult.error) throw new Error("No se pudo cargar el historial del asistente.");
  const recent = (recentResult.data ?? [])
    .map(parseQueryRow)
    .filter((query) => canUseExpenseAssistantIntent(context, query.intent));

  if (!selectedQueryId || !z.string().uuid().safeParse(selectedQueryId).success) {
    return { selected: null, recent };
  }
  const fromRecent = recent.find((query) => query.id === selectedQueryId);
  if (fromRecent) return { selected: fromRecent, recent };

  const selectedResult = await supabase
    .from("expense_assistant_queries")
    .select(fields)
    .eq("company_id", context.id)
    .eq("actor_id", context.userId)
    .eq("id", selectedQueryId)
    .maybeSingle();
  if (selectedResult.error) throw new Error("No se pudo cargar la consulta del asistente.");
  return {
    selected: selectedResult.data
      ? (() => {
          const parsed = parseQueryRow(selectedResult.data);
          return canUseExpenseAssistantIntent(context, parsed.intent) ? parsed : null;
        })()
      : null,
    recent,
  };
}
