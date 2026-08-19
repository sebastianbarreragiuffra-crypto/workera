import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { parseBirthdayExcel, planBirthdayImport, executeBirthdayImport } from "./import-birthdays";

/**
 * Fixtures 100% ficticias -- nunca datos reales del Excel de RRHH (PASO 26,
 * 63: "no crear fixtures con personas reales"). Genera un .xlsx sintético en
 * un directorio temporal, replicando la estructura real confirmada por
 * inspección (Fase 7): título en fila 1, encabezado en fila 4, datos desde
 * fila 5, columnas Nº/APELLIDOS/NOMBRES/R.U.T./FECHA DE NACIMIENTO/MES.
 */
function buildFixtureWorkbook(rows: (string | number | null)[][]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "birthday-fixture-"));
  const filePath = path.join(dir, "fixture.xlsx");
  const sheetRows: (string | number | null)[][] = [
    [null, "TÍTULO FICTICIO DE PRUEBA"],
    [],
    [],
    ["Nº", "APELLIDOS", "NOMBRES", "R.U.T.", "FECHA DE NACIMIENTO", "MES"],
    ...rows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function excelDateSerial(year: number, month: number, day: number): number {
  // Serial de Excel: días desde 1899-12-30 (convención estándar de XLSX.SSF).
  const epoch = Date.UTC(1899, 11, 30);
  const target = Date.UTC(year, month - 1, day);
  return Math.round((target - epoch) / 86_400_000);
}

test("parseBirthdayExcel: filas válidas se parsean con mes/día correctos", () => {
  const filePath = buildFixtureWorkbook([
    [1, "PÉREZ GONZÁLEZ", "JUAN CARLOS", "11.111.111-1", excelDateSerial(1990, 3, 15), "MARZO"],
    [2, "SOTO ROJAS", "ANA MARÍA", "22.222.222-2", excelDateSerial(1985, 12, 1), "DICIEMBRE"],
  ]);
  try {
    const result = parseBirthdayExcel(filePath);
    assert.equal(result.valid.length, 2);
    assert.equal(result.issues.length, 0);
    assert.deepEqual(
      result.valid.map((r) => [r.firstName, r.lastName, r.birthMonth, r.birthDay]),
      [
        ["JUAN CARLOS", "PÉREZ GONZÁLEZ", 3, 15],
        ["ANA MARÍA", "SOTO ROJAS", 12, 1],
      ]
    );
  } finally {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("parseBirthdayExcel: fila sin nombre/apellido se reporta MISSING_NAME, no se importa", () => {
  const filePath = buildFixtureWorkbook([
    [1, "", "JUAN", "11.111.111-1", excelDateSerial(1990, 3, 15), "MARZO"],
    [2, "SOTO", "", "22.222.222-2", excelDateSerial(1985, 12, 1), "DICIEMBRE"],
  ]);
  try {
    const result = parseBirthdayExcel(filePath);
    assert.equal(result.valid.length, 0);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.every((i) => i.reason === "MISSING_NAME"));
  } finally {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("parseBirthdayExcel: fila sin fecha se reporta MISSING_DATE", () => {
  const filePath = buildFixtureWorkbook([[1, "SOTO", "JUAN", "11.111.111-1", null, ""]]);
  try {
    const result = parseBirthdayExcel(filePath);
    assert.equal(result.valid.length, 0);
    assert.equal(result.issues[0]?.reason, "MISSING_DATE");
  } finally {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("parseBirthdayExcel: nombre duplicado (normalizado) se reporta DUPLICATE_NAME, solo la primera fila se importa", () => {
  const filePath = buildFixtureWorkbook([
    [1, "SOTO ROJAS", "JUAN CARLOS", "11.111.111-1", excelDateSerial(1990, 3, 15), "MARZO"],
    [2, "soto   rojas", "juan   carlos", "22.222.222-2", excelDateSerial(1991, 4, 1), "ABRIL"],
  ]);
  try {
    const result = parseBirthdayExcel(filePath);
    assert.equal(result.valid.length, 1);
    assert.equal(result.issues[0]?.reason, "DUPLICATE_NAME");
  } finally {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("parseBirthdayExcel: fila totalmente en blanco se ignora sin generar un issue", () => {
  const filePath = buildFixtureWorkbook([
    [1, "SOTO", "JUAN", "11.111.111-1", excelDateSerial(1990, 3, 15), "MARZO"],
    [null, null, null, null, null, null],
    [2, "PEREZ", "ANA", "22.222.222-2", excelDateSerial(1991, 4, 1), "ABRIL"],
  ]);
  try {
    const result = parseBirthdayExcel(filePath);
    assert.equal(result.valid.length, 2);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// planBirthdayImport / executeBirthdayImport -- mock de Supabase.

function createMockSupabase(employees: { id: string; first_name: string; last_name: string }[], existingBirthdayEmployeeIds: string[] = []) {
  const inserted: unknown[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      const builder = {
        select() {
          return builder;
        },
        insert(rows: unknown) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          if (table === "employees") return onResolve({ data: employees, error: null });
          if (table === "employee_birthdays") {
            return onResolve({ data: existingBirthdayEmployeeIds.map((id) => ({ employee_id: id })), error: null });
          }
          return onResolve({ data: [], error: null });
        },
      };
      return builder;
    },
    inserted,
  };
}

test("planBirthdayImport: match exacto normalizado -> toImport", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "JUAN CARLOS", last_name: "PÉREZ GONZÁLEZ" }]);
  const plan = await planBirthdayImport(mock as never, [
    { rowNumber: 5, firstName: "Juan Carlos", lastName: "Pérez González", birthMonth: 3, birthDay: 15 },
  ]);
  assert.equal(plan.toImport.length, 1);
  assert.equal(plan.toImport[0].employeeId, "emp-1");
  assert.equal(plan.unresolved.length, 0);
});

test("planBirthdayImport: 0 matches -> UNRESOLVED, nunca se adivina por similitud (PASO 27)", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "OTRO", last_name: "NOMBRE" }]);
  const plan = await planBirthdayImport(mock as never, [{ rowNumber: 5, firstName: "Juan", lastName: "Pérez", birthMonth: 3, birthDay: 15 }]);
  assert.equal(plan.toImport.length, 0);
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].matchCount, 0);
});

test("planBirthdayImport: 2+ matches ambiguos -> UNRESOLVED, nunca se elige uno al azar", async () => {
  const mock = createMockSupabase([
    { id: "emp-1", first_name: "JUAN", last_name: "PEREZ" },
    { id: "emp-2", first_name: "JUAN", last_name: "PEREZ" },
  ]);
  const plan = await planBirthdayImport(mock as never, [{ rowNumber: 5, firstName: "Juan", lastName: "Perez", birthMonth: 3, birthDay: 15 }]);
  assert.equal(plan.toImport.length, 0);
  assert.equal(plan.unresolved[0].matchCount, 2);
});

test("planBirthdayImport: empleado ya con cumpleaños importado -> alreadyImported, no se reimporta", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "JUAN", last_name: "PEREZ" }], ["emp-1"]);
  const plan = await planBirthdayImport(mock as never, [{ rowNumber: 5, firstName: "Juan", lastName: "Perez", birthMonth: 3, birthDay: 15 }]);
  assert.equal(plan.toImport.length, 0);
  assert.equal(plan.alreadyImported.length, 1);
});

test("executeBirthdayImport: solo escribe las filas de toImport", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "JUAN", last_name: "PEREZ" }]);
  const result = await executeBirthdayImport(
    mock as never,
    { toImport: [{ rowNumber: 5, employeeId: "emp-1", birthMonth: 3, birthDay: 15 }], alreadyImported: [], unresolved: [] },
    "admin-1"
  );
  assert.equal(result.imported, 1);
  assert.equal(mock.inserted.length, 1);
});

test("executeBirthdayImport: plan vacío no escribe nada", async () => {
  const mock = createMockSupabase([]);
  const result = await executeBirthdayImport(mock as never, { toImport: [], alreadyImported: [], unresolved: [] }, "admin-1");
  assert.equal(result.imported, 0);
  assert.equal(mock.inserted.length, 0);
});
