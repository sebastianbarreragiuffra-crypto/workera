import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExpenseCompanyContext } from "./access";
import { validAccountingPayload } from "@/lib/expense-accounting/fixture";
import {
  applyExpenseAccountingRuntimePause,
  getExpenseAccountingDashboard,
  getExpenseBankCandidates,
  getExpenseIndicators,
  parseExpenseIndicators,
  parseExpenseListFilters,
} from "./data";

test("la pausa global presenta QUEUED/RETRY como backlog retenido, no como recuperación técnica", () => {
  const health = applyExpenseAccountingRuntimePause({
    enqueueEnabled: true,
    queuedCount: 2,
    retryCount: 1,
    processingCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    succeededCount: 4,
    staleProcessingCount: 0,
    staleReadyCount: 3,
    pausedBacklogCount: 0,
    oldestReadyAt: "2026-09-04T08:00:00.000Z",
    requiresHumanReview: false,
    requiresWorkerRecovery: true,
    requiresAttention: true,
    pausedWithBacklog: false,
  }, false);

  assert.equal(health.pausedBacklogCount, 3);
  assert.equal(health.pausedWithBacklog, true);
  assert.equal(health.staleReadyCount, 0);
  assert.equal(health.requiresWorkerRecovery, false);
  assert.equal(health.requiresAttention, false);
});

test("la pausa global conserva recuperación técnica para un lease PROCESSING vencido", () => {
  const base = {
    enqueueEnabled: true,
    queuedCount: 1,
    retryCount: 0,
    processingCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    succeededCount: 0,
    staleProcessingCount: 1,
    staleReadyCount: 1,
    pausedBacklogCount: 0,
    oldestReadyAt: "2026-09-04T08:00:00.000Z",
    requiresHumanReview: false,
    requiresWorkerRecovery: true,
    requiresAttention: true,
    pausedWithBacklog: false,
  };

  const paused = applyExpenseAccountingRuntimePause(base, false);
  assert.equal(paused.pausedWithBacklog, true);
  assert.equal(paused.requiresWorkerRecovery, true);
  assert.equal(paused.requiresAttention, true);
  assert.strictEqual(applyExpenseAccountingRuntimePause(base, true), base);
});

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

test("getExpenseAccountingDashboard pagina la DLQ aparte del historial y conserva el tenant", async () => {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const tableFilters: unknown[] = [];
  const ranges: Array<[number, number]> = [];
  const orders: Array<{ kind: string; column: string }> = [];
  const accountingContext = { ...context, canReconcile: true };
  let tableCall = 0;
  const client = {
    async rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (name === "list_expense_accounting_ready_reports") {
        return { data: [], error: null };
      }
      return {
        data: [{
          enqueue_enabled: true,
          queued_count: 1,
          retry_count: 2,
          processing_count: 0,
          failed_count: 1,
          cancelled_count: 0,
          succeeded_count: 3,
          stale_processing_count: 0,
          stale_ready_count: 0,
          paused_backlog_count: 0,
          oldest_ready_at: "2026-09-04T10:00:00.000Z",
          requires_human_review: true,
          requires_worker_recovery: false,
          requires_attention: true,
          paused_with_backlog: false,
        }],
        error: null,
      };
    },
    from(table: string) {
      assert.equal(table, "expense_accounting_exports");
      const kind = tableCall++ === 0 ? "recent" : "failures";
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) {
          tableFilters.push({ kind, operator: "eq", column, value });
          return query;
        },
        neq(column: string, value: unknown) {
          tableFilters.push({ kind, operator: "neq", column, value });
          return query;
        },
        order(column: string) { orders.push({ kind, column }); return query; },
        async limit() { return { data: [], error: null }; },
        async range(from: number, to: number) {
          ranges.push([from, to]);
          return {
            data: [{
              id: "10000000-0000-4000-8000-000000000001",
              report_id: validAccountingPayload.report.id,
              provider_code: "LEDGER_CSV_V1",
              status: "FAILED",
              attempt_count: 5,
              manual_replay_count: 1,
              requested_by: "20000000-0000-4000-8000-000000000001",
              requested_at: "2026-09-04T09:00:00.000Z",
              updated_at: "2026-09-04T10:00:00.000Z",
              exported_at: null,
              external_reference: null,
              last_error_code: "PROVIDER_TIMEOUT",
              last_error_summary: "Timeout del ERP",
              payload: validAccountingPayload,
            }],
            count: 101,
            error: null,
          };
        },
      };
      return query;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getExpenseAccountingDashboard(client as any, accountingContext, { failurePage: 5 });
  assert.deepEqual(tableFilters, [
    { kind: "recent", operator: "eq", column: "company_id", value: "company-1" },
    { kind: "recent", operator: "neq", column: "status", value: "FAILED" },
    { kind: "failures", operator: "eq", column: "company_id", value: "company-1" },
    { kind: "failures", operator: "eq", column: "status", value: "FAILED" },
  ]);
  assert.deepEqual(ranges, [[100, 124]]);
  assert.deepEqual(orders, [
    { kind: "recent", column: "requested_at" },
    { kind: "failures", column: "updated_at" },
    { kind: "failures", column: "id" },
  ]);
  assert.deepEqual(rpcCalls, [
    { name: "list_expense_accounting_ready_reports", args: { p_company_id: "company-1" } },
    { name: "get_expense_accounting_company_health", args: { p_company_id: "company-1" } },
  ]);
  assert.equal(result.exports[0].manualReplayCount, 1);
  assert.equal(result.exports[0].requestedBy, "20000000-0000-4000-8000-000000000001");
  assert.equal(result.exports[0].lastErrorCode, "PROVIDER_TIMEOUT");
  assert.equal(result.failureTotal, 101);
  assert.equal(result.failurePage, 5);
  assert.equal(result.health.failedCount, 1);
  assert.equal(result.health.enqueueEnabled, true);
  assert.equal(result.health.requiresHumanReview, true);
  assert.equal(result.health.pausedWithBacklog, false);
});

test("getExpenseAccountingDashboard no toca la base sin permiso contable", async () => {
  let called = false;
  const client = {
    rpc() { called = true; throw new Error("no debe llamarse"); },
    from() { called = true; throw new Error("no debe llamarse"); },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getExpenseAccountingDashboard(client as any, context);
  assert.deepEqual(result, {
    ready: [],
    exports: [],
    health: {
      enqueueEnabled: false,
      queuedCount: 0,
      retryCount: 0,
      processingCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      succeededCount: 0,
      staleProcessingCount: 0,
      staleReadyCount: 0,
      pausedBacklogCount: 0,
      oldestReadyAt: null,
      requiresHumanReview: false,
      requiresWorkerRecovery: false,
      requiresAttention: false,
      pausedWithBacklog: false,
    },
    failurePage: 1,
    failurePageSize: 25,
    failureTotal: 0,
  });
  assert.equal(called, false);
});
