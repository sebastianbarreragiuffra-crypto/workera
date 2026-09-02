import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildReimbursementExportWorkbook, monthBounds } from "./reimbursement-export";

test("monthBounds calcula el primer día del mes siguiente, incluido el cruce de año", () => {
  assert.deepEqual(monthBounds("2026-09"), { startDate: "2026-09-01", nextMonthStartDate: "2026-10-01" });
  assert.deepEqual(monthBounds("2026-12"), { startDate: "2026-12-01", nextMonthStartDate: "2027-01-01" });
});

test("monthBounds rechaza un formato que no sea YYYY-MM", () => {
  assert.throws(() => monthBounds("2026-13"), RangeError);
  assert.throws(() => monthBounds("09-2026"), RangeError);
});

test("la planilla de reembolso agrupa por persona y moneda, sin mezclar totales entre monedas", () => {
  const workbook = buildReimbursementExportWorkbook({
    companyName: "ARCOTEX",
    month: "2026-09",
    rows: [
      { employeeName: "Ana Soto", currencyCode: "CLP", totalAmount: 45000, reportCount: 2, referenceNumbers: ["R-0001", "R-0002"] },
      { employeeName: "Ana Soto", currencyCode: "USD", totalAmount: 30, reportCount: 1, referenceNumbers: ["R-0003"] },
      { employeeName: "Beto Ríos", currencyCode: "CLP", totalAmount: 12000, reportCount: 1, referenceNumbers: ["R-0004"] },
    ],
  });

  const parsed = XLSX.read(workbook, { type: "array" });
  const sheet = parsed.Sheets["Reembolsos"];
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });

  const dataRows = rows.filter((row) => row[0] === "Ana Soto" || row[0] === "Beto Ríos");
  assert.deepEqual(dataRows, [
    ["Ana Soto", "CLP", 45000, 2, "R-0001, R-0002"],
    ["Ana Soto", "USD", 30, 1, "R-0003"],
    ["Beto Ríos", "CLP", 12000, 1, "R-0004"],
  ]);

  const totalRows = rows.filter((row) => row[0] === "Total");
  assert.equal(totalRows.length, 2, "un total separado por cada moneda presente, nunca uno mezclado");
});
