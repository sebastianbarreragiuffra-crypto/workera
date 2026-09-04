import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExpenseCompanyContext } from "./access";
import { getExpenseBankCandidates, getExpenseIndicators, parseExpenseIndicators, parseExpenseListFilters } from "./data";

/**
 * La query string la escribe cualquiera. Estos filtros terminan en un
 * `.range()` de PostgREST y en `santiagoDayStartIso`, que lanza ante un día
 * inexistente -- y las páginas de rendiciones no envuelven esas llamadas en
 * try/catch, así que todo lo que este parser deje pasar mal se convierte en un
 * 500 provocable desde la barra de direcciones.
 */

test("pagina: un valor normal se respeta", () => {
  assert.equal(parseExpenseListFilters({ pagina: "3" }).page, 3);
});

test("pagina: 0 y negativos caen a 1 -- producían el rango [-20,-1] que PostgREST rechaza", () => {
  assert.equal(parseExpenseListFilters({ pagina: "0" }).page, 1);
  assert.equal(parseExpenseListFilters({ pagina: "-5" }).page, 1);
});

test("pagina: basura, vacío y ausente caen a 1", () => {
  assert.equal(parseExpenseListFilters({ pagina: "abc" }).page, 1);
  assert.equal(parseExpenseListFilters({ pagina: "" }).page, 1);
  assert.equal(parseExpenseListFilters({}).page, 1);
});

test("pagina: un entero fuera del rango seguro cae a 1, nunca a un offset absurdo", () => {
  assert.equal(parseExpenseListFilters({ pagina: "99999999999999999999" }).page, 1);
});

test("estado: solo se acepta un estado real del enum", () => {
  assert.equal(parseExpenseListFilters({ estado: "APPROVED" }).status, "APPROVED");
  assert.equal(parseExpenseListFilters({ estado: "approved" }).status, null);
  assert.equal(parseExpenseListFilters({ estado: "DROP TABLE" }).status, null);
});

test("desde/hasta: una fecha real se conserva", () => {
  const filters = parseExpenseListFilters({ desde: "2026-09-01", hasta: "2026-09-30" });
  assert.equal(filters.from, "2026-09-01");
  assert.equal(filters.to, "2026-09-30");
});

test("desde/hasta: una fecha con formato válido pero inexistente se descarta", () => {
  // Cumplen la regex YYYY-MM-DD y no existen: antes llegaban a
  // santiagoDayStartIso y tiraban la página.
  assert.equal(parseExpenseListFilters({ desde: "2026-13-45" }).from, null);
  assert.equal(parseExpenseListFilters({ desde: "2026-02-30" }).from, null);
  assert.equal(parseExpenseListFilters({ hasta: "2025-02-29" }).to, null);
});

test("desde/hasta: formato incorrecto o basura se descarta", () => {
  assert.equal(parseExpenseListFilters({ desde: "2026-9-1" }).from, null, "sin ceros a la izquierda");
  assert.equal(parseExpenseListFilters({ desde: "01-09-2026" }).from, null);
  assert.equal(parseExpenseListFilters({ desde: "ayer" }).from, null);
});

test("desde/hasta: un rango invertido descarta el extremo final, no ambos", () => {
  const filters = parseExpenseListFilters({ desde: "2026-09-30", hasta: "2026-09-01" });
  assert.equal(filters.from, "2026-09-30");
  assert.equal(filters.to, null);
});

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

test("getExpenseBankCandidates no presenta un fallo operativo como una lista legítimamente vacía", async () => {
  const client = { async rpc() { return { data: null, error: { message: "network down" } }; } };
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => getExpenseBankCandidates(client as any, { ...context, canReconcile: true }, "tx-1"),
    /No se pudieron calcular las sugerencias bancarias/
  );
});

test("getExpenseBankCandidates no consulta el RPC sin permiso de conciliación", async () => {
  let called = false;
  const client = { async rpc() { called = true; return { data: [], error: null }; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(await getExpenseBankCandidates(client as any, context, "tx-1"), []);
  assert.equal(called, false);
});
