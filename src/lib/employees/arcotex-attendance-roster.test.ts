import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  ARCOTEX_ATTENDANCE_SHEETS,
  approvedArcotexEmployeeIds,
  computeArcotexAttendanceRosterPreview,
  parseArcotexAttendanceRoster,
  type ArcotexExistingEmployee,
} from "./arcotex-attendance-roster";

function personName(index: number): string {
  return `APELLIDO${String(index).padStart(2, "0")} NOMBRE${String(index).padStart(2, "0")}`;
}

function buildRosterBytes(options?: { differentCurrentSheets?: boolean; includeAuxiliary?: boolean }): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const sheetName of ARCOTEX_ATTENDANCE_SHEETS) {
    const count = sheetName === "FEBRERO" || sheetName === "MARZO" ? 45 : 60;
    const rows: unknown[][] = [["Nombre", "Tipo"]];
    for (let index = 1; index <= count; index += 1) {
      const actualIndex = options?.differentCurrentSheets && sheetName === "MARZO" && index === 45 ? 46 : index;
      const suffix = sheetName === "NOV25" && actualIndex === 60 ? " FINIQUITO MUTUO ACUERDO" : " Lunes a Viernes 08:00 a 17:00";
      rows.push([`${personName(actualIndex)}${suffix}`, "Asistencia"]);
    }
    if (sheetName === "ENERO") rows.push([`${personName(10)} TURNO ESPECIAL`, "Asistencia"]);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }

  if (options?.includeAuxiliary) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["NOMBRE", "RUT"],
        [personName(5), "11.111.111-1"],
        [personName(6), "22.222.222-2"],
        ["PERSONA SOLO AUXILIAR", "33.333.333-3"],
      ]),
      "ALUMNOS PRACTICA",
    );
  }

  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

function employee(index: number, overrides: Partial<ArcotexExistingEmployee> = {}): ArcotexExistingEmployee {
  return {
    id: `employee-${index}`,
    externalWorkeraId: `W-${index}`,
    displayName: personName(index),
    firstName: `NOMBRE${String(index).padStart(2, "0")}`,
    lastName: `APELLIDO${String(index).padStart(2, "0")}`,
    active: true,
    ...overrides,
  };
}

test("padrón Arcotex: une 60 nombres sin inferir vigencia y deduplica la repetida de ENERO", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes());

  assert.equal(parsed.rosterCount, 60);
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(parsed.duplicateRowsWithinSheet, [
    { normalizedName: personName(10), sheetName: "ENERO", rowNumbers: [11, 62] },
  ]);
});

test("padrón Arcotex: una persona que sólo está en una hoja auxiliar nunca se agrega al padrón", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes({ includeAuxiliary: true }));

  assert.equal(parsed.people.some((person) => person.normalizedName === "PERSONA SOLO AUXILIAR"), false);
  assert.equal(parsed.rosterCount, 60);
});

test("padrón Arcotex: diferencias entre meses no se interpretan como altas, bajas ni vigencia laboral", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes({ differentCurrentSheets: true }));

  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.rosterCount, 60);
});

test("conciliación Arcotex: sólo vincula nombre completo exacto o resolución explícita con evidencia", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes({ includeAuxiliary: true }));
  const employees = [
    employee(1),
    employee(2),
    employee(3, { displayName: "NOMBRE03 SEGUNDO APELLIDO03", firstName: "NOMBRE03 SEGUNDO", lastName: "APELLIDO03" }),
    employee(6, { displayName: "OTRO NOMBRE", firstName: "OTRO", lastName: "NOMBRE" }),
  ];

  const preview = computeArcotexAttendanceRosterPreview(parsed, employees, [
    { sourceNormalizedName: personName(2), employeeId: "employee-2", evidence: "Resolución revisada contra una fila complementaria del libro." },
  ], [
    { sourceNormalizedName: personName(4), temporaryCode: "LOCAL-PROVISIONAL:PERSONA-4", groupCode: "ADMINISTRATION", evidence: "Alta local provisional autorizada." },
  ]);

  assert.equal(preview.rows.find((row) => row.normalizedName === personName(1))?.status, "LINKED_EXACT_NAME");
  assert.equal(preview.rows.find((row) => row.normalizedName === personName(2))?.status, "LINKED_EXPLICIT");
  assert.equal(preview.rows.find((row) => row.normalizedName === personName(3))?.status, "AMBIGUOUS");
  assert.equal(preview.rows.find((row) => row.normalizedName === personName(3))?.matchedEmployee, null);
  assert.equal(preview.rows.find((row) => row.normalizedName === personName(4))?.status, "POSSIBLE_NEW");
  assert.equal(preview.rows.find((row) => row.normalizedName === personName(6))?.status, "MISSING_IDENTITY");
  assert.equal(preview.okToApply, false);
});

test("conciliación Arcotex: una resolución explícita inválida nunca vincula ni habilita la aplicación", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes());
  const preview = computeArcotexAttendanceRosterPreview(parsed, [], [
    { sourceNormalizedName: personName(1), employeeId: "no-existe", evidence: "Evidencia insuficiente" },
  ]);

  assert.equal(preview.rows[0].matchedEmployee, null);
  assert.equal(preview.rows[0].status, "MISSING_IDENTITY");
  assert.equal(preview.okToApply, false);
});

test("filtro Arcotex: falla cerrado con pendientes y entrega los 60 nombres autorizados sólo cuando todo está respaldado", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes());
  const blocked = computeArcotexAttendanceRosterPreview(parsed, Array.from({ length: 59 }, (_, index) => employee(index + 1)));
  assert.throws(() => approvedArcotexEmployeeIds(blocked), /no está aprobado/);

  const approved = computeArcotexAttendanceRosterPreview(parsed, Array.from({ length: 60 }, (_, index) => employee(index + 1)));
  assert.equal(approved.okToApply, true);
  assert.equal(approvedArcotexEmployeeIds(approved).size, 60);
});
