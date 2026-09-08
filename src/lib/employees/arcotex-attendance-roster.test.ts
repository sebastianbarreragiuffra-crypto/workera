import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  ARCOTEX_ATTENDANCE_ROSTER_SIZE,
  ARCOTEX_ATTENDANCE_SHEETS,
  approvedArcotexEmployeeIds,
  canonicalArcotexRosterNamesSha256,
  computeArcotexAttendanceRosterPreview,
  parseArcotexAttendanceRoster,
  type ArcotexExistingEmployee,
} from "./arcotex-attendance-roster";

test("huella nominal Arcotex: es estable frente a orden, tildes y espacios", () => {
  assert.equal(
    canonicalArcotexRosterNamesSha256(["  José Pérez ", "Ana Soto"]),
    canonicalArcotexRosterNamesSha256(["ANA SOTO", "JOSE PEREZ"]),
  );
});

function personName(index: number): string {
  return `APELLIDO${String(index).padStart(2, "0")} NOMBRE${String(index).padStart(2, "0")}`;
}

function buildRosterBytes(options?: {
  differentCurrentSheets?: boolean;
  februaryCount?: number;
  includeAuxiliary?: boolean;
}): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const sheetName of ["NOV25", "DIC25", "ENERO"] as const) {
    const rows: unknown[][] = [["Nombre", "Tipo"]];
    for (let index = 1; index <= 60; index += 1) {
      rows.push([`${personName(index)} TURNO HISTÓRICO`, "Asistencia"]);
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }

  for (const sheetName of ARCOTEX_ATTENDANCE_SHEETS) {
    const count = sheetName === "FEBRERO"
      ? options?.februaryCount ?? ARCOTEX_ATTENDANCE_ROSTER_SIZE
      : ARCOTEX_ATTENDANCE_ROSTER_SIZE;
    const rows: unknown[][] = [["Nombre", "Tipo"]];
    for (let index = 1; index <= count; index += 1) {
      const actualIndex = options?.differentCurrentSheets
        && sheetName === "MARZO"
        && index === ARCOTEX_ATTENDANCE_ROSTER_SIZE
        ? ARCOTEX_ATTENDANCE_ROSTER_SIZE + 1
        : index;
      const suffix = " Lunes a Viernes 08:00 a 17:00";
      rows.push([`${personName(actualIndex)}${suffix}`, "Asistencia"]);
    }
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

test("padrón Arcotex: usa únicamente los mismos 45 nombres de FEBRERO y MARZO", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes());

  assert.equal(parsed.rosterCount, ARCOTEX_ATTENDANCE_ROSTER_SIZE);
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(parsed.duplicateRowsWithinSheet, []);
  assert.ok(parsed.people.every((person) =>
    person.occurrences.some((occurrence) => occurrence.sheetName === "FEBRERO")
      && person.occurrences.some((occurrence) => occurrence.sheetName === "MARZO")
  ));
  assert.equal(parsed.people.some((person) => person.normalizedName === personName(60)), false);
});

test("padrón Arcotex: una persona que sólo está en una hoja auxiliar nunca se agrega al padrón", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes({ includeAuxiliary: true }));

  assert.equal(parsed.people.some((person) => person.normalizedName === "PERSONA SOLO AUXILIAR"), false);
  assert.equal(parsed.rosterCount, ARCOTEX_ATTENDANCE_ROSTER_SIZE);
});

test("padrón Arcotex: bloquea si FEBRERO y MARZO no contienen el mismo conjunto", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes({ differentCurrentSheets: true }));
  const preview = computeArcotexAttendanceRosterPreview(
    parsed,
    Array.from({ length: ARCOTEX_ATTENDANCE_ROSTER_SIZE + 1 }, (_, index) => employee(index + 1)),
  );

  assert.ok(parsed.issues.some((issue) => issue.code === "ROSTER_SHEET_MISMATCH" && issue.blocking));
  assert.equal(preview.okToApply, false);
  assert.throws(() => approvedArcotexEmployeeIds(preview), /no está aprobado/);
});

test("padrón Arcotex: exige 45 personas en cada hoja vigente", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes({ februaryCount: 44 }));

  assert.ok(parsed.issues.some((issue) =>
    issue.code === "UNEXPECTED_ROSTER_COUNT" && issue.detail.includes("FEBRERO")
  ));
  assert.ok(parsed.issues.some((issue) => issue.code === "ROSTER_SHEET_MISMATCH"));
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

test("conciliación Arcotex: dos nombres no pueden resolverse a la misma ficha", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes());
  const preview = computeArcotexAttendanceRosterPreview(
    parsed,
    Array.from({ length: ARCOTEX_ATTENDANCE_ROSTER_SIZE }, (_, index) => employee(index + 1)),
    [{
      sourceNormalizedName: personName(ARCOTEX_ATTENDANCE_ROSTER_SIZE),
      employeeId: `employee-${ARCOTEX_ATTENDANCE_ROSTER_SIZE - 1}`,
      evidence: "Resolución ficticia duplicada para comprobar el bloqueo.",
    }],
  );

  assert.equal(preview.okToApply, true);
  assert.throws(() => approvedArcotexEmployeeIds(preview), /45 fichas distintas/);
});

test("filtro Arcotex: falla cerrado con pendientes y entrega los 45 nombres autorizados sólo cuando todo está respaldado", () => {
  const parsed = parseArcotexAttendanceRoster(buildRosterBytes());
  const blocked = computeArcotexAttendanceRosterPreview(
    parsed,
    Array.from({ length: ARCOTEX_ATTENDANCE_ROSTER_SIZE - 1 }, (_, index) => employee(index + 1)),
  );
  assert.throws(() => approvedArcotexEmployeeIds(blocked), /no está aprobado/);

  const provisional = computeArcotexAttendanceRosterPreview(
    parsed,
    Array.from({ length: ARCOTEX_ATTENDANCE_ROSTER_SIZE - 1 }, (_, index) => employee(index + 1)),
    [],
    [{
      sourceNormalizedName: personName(ARCOTEX_ATTENDANCE_ROSTER_SIZE),
      temporaryCode: `LOCAL-PROVISIONAL:PERSONA-${ARCOTEX_ATTENDANCE_ROSTER_SIZE}`,
      groupCode: "ADMINISTRATION",
      evidence: "Alta local provisional expresamente autorizada.",
    }],
  );
  assert.equal(provisional.okToApply, true);
  assert.equal(provisional.possibleNewCount, 1);
  assert.throws(() => approvedArcotexEmployeeIds(provisional), /aún no persistidas/);

  const approved = computeArcotexAttendanceRosterPreview(
    parsed,
    Array.from({ length: ARCOTEX_ATTENDANCE_ROSTER_SIZE }, (_, index) => employee(index + 1)),
  );
  assert.equal(approved.okToApply, true);
  assert.equal(approvedArcotexEmployeeIds(approved).size, ARCOTEX_ATTENDANCE_ROSTER_SIZE);
});
