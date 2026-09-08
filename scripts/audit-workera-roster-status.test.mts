import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildWorkeraRosterStatusAudit } from "./audit-workera-roster-status-lib";

const entrypointSource = readFileSync(
  new URL("./audit-workera-roster-status.mts", import.meta.url),
  "utf8",
);

test("el entrypoint usa el cliente compartido y no acepta un company_id arbitrario", () => {
  assert.match(entrypointSource, /new HttpWorkeraClient\(/);
  assert.match(entrypointSource, /client\.getAllEmployeeRoster\(filters\)/);
  assert.match(entrypointSource, /collectArcotexLocalRosterStatusRows\(\)/);
  assert.doesNotMatch(entrypointSource, /--company-id|WORKERA_ROSTER_AUDIT_COMPANY_ID/);
});

test("resume estados y discrepancias sin incluir identificadores en la salida", () => {
  const sensitiveCodes = [
    "worker-secret-code-1",
    "worker-secret-code-2",
    "worker-secret-code-3",
    "worker-secret-code-4",
    "worker-secret-code-5",
    "LOCAL-PROVISIONAL:PERSONA-SECRETA",
    "EXCEL-RUT-SECRETO",
  ];
  const report = buildWorkeraRosterStatusAudit(
    [
      { code: sensitiveCodes[0], employeeStatus: "ACTIVO" },
      { code: sensitiveCodes[1], employeeStatus: "INACTIVO" },
      { code: sensitiveCodes[2], employeeStatus: "activo" },
      { code: sensitiveCodes[3], employeeStatus: null },
    ],
    [
      { externalWorkeraId: sensitiveCodes[0], source: "workera", active: true },
      { externalWorkeraId: sensitiveCodes[1], source: "workera", active: true },
      { externalWorkeraId: sensitiveCodes[2], source: "workera", active: false },
      { externalWorkeraId: sensitiveCodes[4], source: "workera", active: false },
      { externalWorkeraId: sensitiveCodes[5], source: "local_provisional", active: true },
      { externalWorkeraId: sensitiveCodes[6], source: "excel_roster", active: false },
    ],
  );

  assert.deepEqual(report, {
    schemaVersion: 1,
    readOnly: true,
    workera: {
      records: 4,
      uniqueCodes: 4,
      duplicateCodeRows: 0,
      contradictoryStatusCodes: 0,
      recordsWithoutCode: 0,
      statuses: { ACTIVO: 2, INACTIVO: 1, SIN_ESTADO: 1, OTRO: 0 },
    },
    local: {
      employees: 6,
      active: 3,
      inactive: 3,
      uniqueExternalCodes: 6,
      duplicateExternalCodeRows: 0,
      recordsWithoutExternalCode: 0,
      sources: { workera: 4, provisional: 1, other: 1 },
      workeraSource: { active: 2, inactive: 2 },
    },
    comparison: {
      matched: 3,
      missingLocally: 1,
      extraLocalWorkera: 1,
      provisionals: 1,
      otherLocalSources: 1,
      mismatches: {
        localActiveWorkeraInactive: 1,
        localInactiveWorkeraActive: 1,
        unresolvedMatchedStatus: 0,
      },
    },
  });

  const serialized = JSON.stringify(report);
  for (const sensitiveCode of sensitiveCodes) assert.doesNotMatch(serialized, new RegExp(sensitiveCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /company[_-]?id/i);
});

test("reduce estados desconocidos y duplicados a conteos seguros", () => {
  const report = buildWorkeraRosterStatusAudit(
    [
      { code: "duplicate-sensitive-code", employeeStatus: "ACTIVO" },
      { code: "duplicate-sensitive-code", employeeStatus: "INACTIVO" },
      { code: "other-sensitive-code", employeeStatus: "SUSPENDIDO POR REVISAR" },
      { code: "   ", employeeStatus: null },
    ],
    [
      { externalWorkeraId: "duplicate-sensitive-code", source: "workera", active: true },
      { externalWorkeraId: "duplicate-sensitive-code", source: "workera", active: false },
      { externalWorkeraId: "   ", source: "local_provisional", active: true },
    ],
  );

  assert.deepEqual(report.workera, {
    records: 4,
    uniqueCodes: 2,
    duplicateCodeRows: 1,
    contradictoryStatusCodes: 1,
    recordsWithoutCode: 1,
    statuses: { ACTIVO: 1, INACTIVO: 1, SIN_ESTADO: 1, OTRO: 1 },
  });
  assert.deepEqual(report.local, {
    employees: 3,
    active: 2,
    inactive: 1,
    uniqueExternalCodes: 1,
    duplicateExternalCodeRows: 1,
    recordsWithoutExternalCode: 1,
    sources: { workera: 2, provisional: 1, other: 0 },
    workeraSource: { active: 1, inactive: 1 },
  });
  assert.deepEqual(report.comparison, {
    matched: 1,
    missingLocally: 1,
    extraLocalWorkera: 0,
    provisionals: 1,
    otherLocalSources: 0,
    mismatches: {
      localActiveWorkeraInactive: 0,
      localInactiveWorkeraActive: 0,
      unresolvedMatchedStatus: 1,
    },
  });
  assert.doesNotMatch(JSON.stringify(report), /SUSPENDIDO|duplicate-sensitive-code|other-sensitive-code/);
});
