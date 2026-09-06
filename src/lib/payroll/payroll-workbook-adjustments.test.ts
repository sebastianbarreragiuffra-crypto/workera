import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAcceptedPayrollWorkbookAdjustments,
  parsePayrollAdjustmentStableKey,
  reduceAcceptedPayrollWorkbookChanges,
} from "./payroll-workbook-adjustments";

test("ajustes aceptados: reduce por versión y conserva una puesta en cero", () => {
  const rows = [
    { stable_key: "emp-1|Ajuste HH50 (minutos)", new_value: 30, source_value_at_accept: 120 / 1_440, decided_at: "2026-09-01T10:00:00Z", version_number: 1 },
    { stable_key: "emp-1|Ajuste HH50 (minutos)", new_value: 0, source_value_at_accept: 180 / 1_440, decided_at: "2026-09-02T10:00:00Z", version_number: 2 },
    { stable_key: "emp-1|Motivo ajuste HH50", new_value: "Corrección cerrada", source_value_at_accept: null, decided_at: "2026-09-02T10:01:00Z", version_number: 2 },
  ];
  const result = reduceAcceptedPayrollWorkbookChanges(rows);
  assert.equal(result.length, 2);
  assert.equal(result.find((item) => item.field === "Ajuste HH50 (minutos)")?.value, 0);
  assert.equal(result.find((item) => item.field === "Ajuste HH50 (minutos)")?.versionNumber, 2);
});

test("ajustes aceptados: ignora claves no permitidas", () => {
  assert.equal(parsePayrollAdjustmentStableKey("emp-1|RUT"), null);
  assert.deepEqual(parsePayrollAdjustmentStableKey("emp-1|Ajuste bono (CLP)"), {
    employeeId: "emp-1",
    workDate: null,
    field: "Ajuste bono (CLP)",
  });
  assert.deepEqual(parsePayrollAdjustmentStableKey("emp-1|2026-09-03|Código asistencia"), {
    employeeId: "emp-1",
    workDate: "2026-09-03",
    field: "Código asistencia",
  });
});

test("ajustes aceptados: pagina versiones y divide consultas de cambios sin truncar", async () => {
  const versions = Array.from({ length: 1_001 }, (_, index) => ({
    id: `version-${index}`,
    version_number: index + 1,
  }));
  const requestedBatches: string[][] = [];
  const requestedOrders: string[] = [];

  function query(table: string) {
    let selectedIds: readonly string[] = [];
    let from = 0;
    let to = 999;
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: (column: string) => {
        requestedOrders.push(`${table}:${column}`);
        return chain;
      },
      in: (_column: string, values: readonly string[]) => {
        selectedIds = values;
        requestedBatches.push([...values]);
        return chain;
      },
      range: (nextFrom: number, nextTo: number) => {
        from = nextFrom;
        to = nextTo;
        return chain;
      },
      then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) => {
        const source = table === "payroll_workbook_versions"
          ? versions
          : selectedIds.map((id) => ({
              workbook_version_id: id,
              stable_key: `${id}|Ajuste HH50 (minutos)`,
              new_value: 1,
              source_value_at_accept: 0,
              decided_at: "2026-09-06T12:00:00Z",
            }));
        return Promise.resolve(resolve({ data: source.slice(from, to + 1), error: null }));
      },
    };
    return chain;
  }

  const result = await loadAcceptedPayrollWorkbookAdjustments(
    { from: (table: string) => query(table) } as never,
    { companyId: "company-1", periodStart: "2026-08-16", periodEnd: "2026-09-15" },
  );

  assert.equal(result.length, 1_001);
  assert.equal(requestedBatches.length, 11);
  assert.ok(requestedBatches.every((batch) => batch.length <= 100));
  assert.equal(requestedOrders.filter((item) => item === "payroll_workbook_changes:decided_at").length, 11);
  assert.equal(requestedOrders.filter((item) => item === "payroll_workbook_changes:id").length, 11);
  assert.equal(result.at(-1)?.versionNumber, 1_001);
});
