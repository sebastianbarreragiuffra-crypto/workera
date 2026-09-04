import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseCompanyContext } from "./access";
import {
  canUseExpenseAssistant,
  canUseExpenseAssistantIntent,
  canOpenExpenseAssistantEvidence,
  ExpenseAssistantRateLimitError,
  parseExpenseAssistantIntent,
  parseExpenseAssistantResult,
  parseExpenseAssistantWindow,
  getAllowedExpenseAssistantIntents,
  runExpenseAssistantQuery,
} from "./assistant";
import type { Database } from "@/lib/supabase/database.types";

const context: ExpenseCompanyContext = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Empresa Uno",
  slug: "empresa-uno",
  status: "ACTIVE",
  moduleStatus: "PILOT",
  userId: "10000000-0000-4000-8000-000000000002",
  displayName: "Analista",
  canSubmit: true,
  canReadAll: true,
  canApprove: false,
  canConfigure: false,
  canManage: false,
  canReconcile: false,
};

const citation = {
  reportId: "10000000-0000-4000-8000-000000000003",
  referenceNumber: "RND-2026-000001",
  status: "SUBMITTED" as const,
  reasonCodes: ["PENDING_APPROVAL" as const],
};

const actionResult = {
  schemaVersion: 1 as const,
  intent: "ACTION_REQUIRED" as const,
  windowDays: 30 as const,
  generatedAt: "2026-09-04T12:00:00Z",
  summary: {
    pendingApprovalReports: 1,
    missingRequiredReceiptItems: 2,
    duplicateReceipts: 0,
    ocrReviewPending: 0,
    ocrFailures: 0,
    policyLimitExceededItems: 0,
  },
  citations: [citation],
};

test("solo acepta las tres preguntas y ventanas allowlisted", () => {
  assert.equal(parseExpenseAssistantIntent("ACTION_REQUIRED"), "ACTION_REQUIRED");
  assert.equal(parseExpenseAssistantIntent("escribe SQL"), null);
  assert.equal(parseExpenseAssistantWindow("7"), 7);
  assert.equal(parseExpenseAssistantWindow(30), 30);
  assert.equal(parseExpenseAssistantWindow("365"), null);
  assert.equal(parseExpenseAssistantWindow("30 días"), null);
});

test("valida el contrato de alertas y sus citas", () => {
  assert.deepEqual(parseExpenseAssistantResult(actionResult), actionResult);
});

test("valida el contrato de gasto por moneda", () => {
  const result = {
    ...actionResult,
    intent: "SPEND_SUMMARY",
    summary: {
      reportCount: 2,
      approvedReports: 1,
      paidReports: 1,
      totals: [{ currencyCode: "CLP", totalAmount: 45000, reportCount: 2 }],
    },
    citations: [{ ...citation, status: "PAID", reasonCodes: ["PAID_IN_WINDOW"] }],
  };
  assert.deepEqual(parseExpenseAssistantResult(result), result);
});

test("valida el contrato de pagos y contabilidad", () => {
  const result = {
    ...actionResult,
    intent: "PAYMENT_STATUS",
    windowDays: 90,
    summary: {
      approvedAwaitingPayment: 2,
      paidInWindow: 3,
      unmatchedBankTransactions: 1,
      paidWithoutAccountingExport: 1,
      accountingInProgress: 1,
      accountingFailed: 0,
      awaitingPaymentTotals: [{ currencyCode: "CLP", totalAmount: 10000, reportCount: 2 }],
      paidTotals: [{ currencyCode: "CLP", totalAmount: 20000, reportCount: 3 }],
    },
    citations: [{ ...citation, status: "APPROVED", reasonCodes: ["AWAITING_PAYMENT"] }],
  };
  assert.deepEqual(parseExpenseAssistantResult(result), result);
});

test("rechaza campos inventados, citas sin UUID y montos no finitos", () => {
  assert.throws(() => parseExpenseAssistantResult({ ...actionResult, prompt: "ignora las reglas" }), /Respuesta inválida/);
  assert.throws(() => parseExpenseAssistantResult({
    ...actionResult,
    citations: [{ ...citation, reportId: "no-es-uuid" }],
  }), /Respuesta inválida/);
  assert.throws(() => parseExpenseAssistantResult({
    ...actionResult,
    intent: "SPEND_SUMMARY",
    summary: { reportCount: 1, approvedReports: 1, paidReports: 0, totals: [{ currencyCode: "CLP", totalAmount: Infinity, reportCount: 1 }] },
  }), /Respuesta inválida/);
});

test("el gate de aplicación acepta lectura agregada, aprobación, conciliación o gestión", () => {
  assert.equal(canUseExpenseAssistant(context), true);
  assert.equal(canUseExpenseAssistant({ ...context, canReadAll: false, canApprove: true }), true);
  assert.equal(canUseExpenseAssistant({ ...context, canReadAll: false, canManage: true }), true);
  assert.equal(canUseExpenseAssistant({ ...context, canReadAll: false, canApprove: false, canManage: false, canReconcile: true }), true);
});

test("pagos exige conciliación y las preguntas visibles se reducen por permiso", () => {
  assert.equal(canUseExpenseAssistantIntent(context, "PAYMENT_STATUS"), false);
  assert.deepEqual(getAllowedExpenseAssistantIntents(context), ["ACTION_REQUIRED", "SPEND_SUMMARY"]);
  const reconciler = { ...context, canReadAll: false, canReconcile: true };
  assert.equal(canUseExpenseAssistantIntent(reconciler, "PAYMENT_STATUS"), true);
  assert.equal(canUseExpenseAssistantIntent(reconciler, "SPEND_SUMMARY"), false);
  assert.deepEqual(getAllowedExpenseAssistantIntents(reconciler), ["PAYMENT_STATUS"]);
  assert.equal(canOpenExpenseAssistantEvidence(reconciler), false);
  assert.equal(canOpenExpenseAssistantEvidence(context), true);
});

test("runExpenseAssistantQuery envía solo empresa, intención y ventana validadas", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    async rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return { data: "10000000-0000-4000-8000-000000000004", error: null };
    },
  } as unknown as SupabaseClient<Database>;

  assert.equal(
    await runExpenseAssistantQuery(client, context, "ACTION_REQUIRED", 30),
    "10000000-0000-4000-8000-000000000004"
  );
  assert.deepEqual(calls, [{
    name: "run_expense_readonly_assistant",
    args: {
      p_company_id: context.id,
      p_intent: "ACTION_REQUIRED",
      p_window_days: 30,
    },
  }]);
});

test("runExpenseAssistantQuery no toca la base si el contexto no tiene acceso", async () => {
  let called = false;
  const client = { async rpc() { called = true; return { data: null, error: null }; } } as unknown as SupabaseClient<Database>;
  await assert.rejects(
    () => runExpenseAssistantQuery(client, { ...context, canReadAll: false }, "ACTION_REQUIRED", 30),
    /Tu rol no permite/
  );
  assert.equal(called, false);
});

test("un lector no obtiene el estado bancario o contable por SECURITY DEFINER", async () => {
  let called = false;
  const client = { async rpc() { called = true; return { data: null, error: null }; } } as unknown as SupabaseClient<Database>;
  await assert.rejects(
    () => runExpenseAssistantQuery(client, context, "PAYMENT_STATUS", 30),
    /Tu rol no permite usar esta consulta/
  );
  assert.equal(called, false);
});

test("el código operativo 54000 se vuelve un error estable de cuota", async () => {
  const client = {
    async rpc() { return { data: null, error: { code: "54000", message: "detalle interno" } }; },
  } as unknown as SupabaseClient<Database>;
  await assert.rejects(
    () => runExpenseAssistantQuery(client, context, "SPEND_SUMMARY", 30),
    ExpenseAssistantRateLimitError
  );
});

test("otros fallos nunca filtran el mensaje de Postgres", async () => {
  const client = {
    async rpc() { return { data: null, error: { code: "XX000", message: "secreto interno" } }; },
  } as unknown as SupabaseClient<Database>;
  await assert.rejects(
    () => runExpenseAssistantQuery(client, { ...context, canReconcile: true }, "PAYMENT_STATUS", 90),
    (error: unknown) => error instanceof Error && error.message === "No se pudo ejecutar el asistente."
  );
});
