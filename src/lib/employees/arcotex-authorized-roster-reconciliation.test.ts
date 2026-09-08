import assert from "node:assert/strict";
import test from "node:test";
import type {
  ArcotexExistingEmployee,
  ArcotexRosterPreview,
  ArcotexRosterPreviewRow,
} from "./arcotex-attendance-roster";
import { canonicalCandidateResolutions } from "./arcotex-authorized-roster-reconciliation";
import { canonicalRosterSha256 } from "./arcotex-pilot-roster";

function employee(index: number, code = `FAKE-${index}`): ArcotexExistingEmployee {
  return {
    id: `employee-${index}`,
    externalWorkeraId: code,
    displayName: `Persona ficticia ${index}`,
    firstName: "Persona",
    lastName: `Ficticia ${index}`,
    active: true,
  };
}

function rowFor(
  index: number,
  matchedEmployee: ArcotexExistingEmployee | null,
): ArcotexRosterPreviewRow {
  return {
    sourceName: `PERSONA FICTICIA ${index}`,
    normalizedName: `PERSONA FICTICIA ${index}`,
    sourceSheets: ["FEBRERO", "MARZO"],
    sourceRows: [`FEBRERO!${index + 1}`, `MARZO!${index + 1}`],
    status: matchedEmployee ? "LINKED_EXACT_NAME" : "MISSING_IDENTITY",
    matchedEmployee: matchedEmployee
      ? {
          employeeId: matchedEmployee.id,
          externalWorkeraId: matchedEmployee.externalWorkeraId,
          displayName: matchedEmployee.displayName,
          active: matchedEmployee.active,
        }
      : null,
    candidates: [],
    matchMethod: matchedEmployee ? "FULL_NAME_EXACT" : "NONE",
    evidence: matchedEmployee ? "Coincidencia ficticia exacta." : "Fixture sin identidad.",
  };
}

function preview(rows: ArcotexRosterPreviewRow[]): ArcotexRosterPreview {
  return {
    rows,
    linkedCount: rows.filter((row) => Boolean(row.matchedEmployee)).length,
    possibleNewCount: 0,
    ambiguousCount: rows.filter((row) => row.status === "AMBIGUOUS").length,
    missingIdentityCount: rows.filter((row) => row.status === "MISSING_IDENTITY").length,
    blockingReasons: [],
    okToApply: false,
  };
}

test("la huella canónica encuentra una única ficha faltante dentro de un padrón ficticio de 45", () => {
  const employees = Array.from({ length: 45 }, (_, index) => employee(index + 1));
  const rows = employees.map((item, index) => rowFor(index + 1, index === 44 ? null : item));
  const expectedHash = canonicalRosterSha256(employees.map((item) => item.externalWorkeraId!));

  const resolutions = canonicalCandidateResolutions(preview(rows), employees, 45, expectedHash);

  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].employeeId, employees[44].id);
});

test("bloquea cuando ninguna combinación satisface la huella autorizada", () => {
  const employees = [employee(1), employee(2)];
  assert.throws(
    () => canonicalCandidateResolutions(preview([rowFor(1, employees[0]), rowFor(2, null)]), employees, 2, "f".repeat(64)),
    /Ninguna conciliación/,
  );
});

test("bloquea dos conjuntos de fichas distintos aunque expongan el mismo código", () => {
  const employees = [employee(1, "CODIGO-COMPARTIDO"), employee(2, "CODIGO-COMPARTIDO")];
  const expectedHash = canonicalRosterSha256(["CODIGO-COMPARTIDO"]);
  assert.throws(
    () => canonicalCandidateResolutions(preview([rowFor(1, null)]), employees, 1, expectedHash),
    /Más de un padrón/,
  );
});
