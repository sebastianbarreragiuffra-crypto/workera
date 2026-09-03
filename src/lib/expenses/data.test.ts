import assert from "node:assert/strict";
import test from "node:test";
import type { ExpenseCompanyContext } from "./access";
import { getExpenseIndicators, parseExpenseIndicators } from "./data";

const context: ExpenseCompanyContext = {
  id: "company-1",
  name: "Empresa Uno",
  slug: "empresa-uno",
  status: "ACTIVE",
  moduleStatus: "PILOT",
  userId: "user-1",
  displayName: "Gestor",
  canSubmit: true,
  canReadAll: true,
  canApprove: false,
  canConfigure: false,
  canManage: false,
  canReconcile: false,
};

const response = {
  windowDays: 90,
  resolvedCount: 4,
  approvedCount: 3,
  rejectedCount: 1,
  avgApprovalHours: 12.5,
  categoryBreakdown: [{ categoryName: "Alimentación", currencyCode: "CLP", totalAmount: 45000, itemCount: 2 }],
  riskSignals: {
    duplicateReceipts: 1,
    missingRequiredReceipts: 2,
    ocrReviewPending: 3,
    ocrFailures: 1,
    policyLimitExceededItems: 1,
    receiptCoveragePercent: 75,
  },
};

test("parseExpenseIndicators valida y conserva el contrato del agregado", () => {
  assert.deepEqual(parseExpenseIndicators(response), response);
});

test("parseExpenseIndicators rechaza respuestas incompletas o con números inválidos", () => {
  assert.throws(() => parseExpenseIndicators({ ...response, riskSignals: null }), /Respuesta inválida/);
  assert.throws(() => parseExpenseIndicators({ ...response, resolvedCount: "4" }), /Respuesta inválida/);
});

test("getExpenseIndicators consulta un único RPC tenant-aware con la ventana solicitada", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    async rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return { data: response, error: null };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getExpenseIndicators(client as any, context, 30);
  assert.deepEqual(result, response);
  assert.deepEqual(calls, [{ name: "get_expense_indicators", args: { p_company_id: "company-1", p_window_days: 30 } }]);
});

test("getExpenseIndicators no consulta datos para un rol sin visibilidad agregada", async () => {
  let called = false;
  const client = { async rpc() { called = true; return { data: response, error: null }; } };
  const submitOnly = { ...context, canReadAll: false, canSubmit: true };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(await getExpenseIndicators(client as any, submitOnly), null);
  assert.equal(called, false);
});

test("getExpenseIndicators convierte un fallo del RPC en un error estable para la UI", async () => {
  const client = { async rpc() { return { data: null, error: { message: "detalle interno" } }; } };
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => getExpenseIndicators(client as any, context),
    /No se pudieron cargar los indicadores/
  );
});
