import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWorkeraAbsence } from "./absence";
import type { AbsenceTypeMappingTable } from "../types/absence-type";

const TYPE_MAPPING: AbsenceTypeMappingTable = {
  TEST_VACATION: "VACATION",
  TEST_MEDICAL_LEAVE: "MEDICAL_LEAVE",
  TEST_MUTUAL: "MUTUAL",
};

test("vacaciones se mapean correctamente", () => {
  const result = mapWorkeraAbsence(
    { employee_id: "E-1", type: "TEST_VACATION", start_date: "2026-08-10", end_date: "2026-08-15" },
    { typeMapping: TYPE_MAPPING }
  );
  assert.equal(result.type, "VACATION");
  assert.equal(result.externalType, "TEST_VACATION");
});

test("licencia médica se mapea correctamente", () => {
  const result = mapWorkeraAbsence(
    { employee_id: "E-1", type: "TEST_MEDICAL_LEAVE", start_date: "2026-08-10", end_date: "2026-08-12" },
    { typeMapping: TYPE_MAPPING }
  );
  assert.equal(result.type, "MEDICAL_LEAVE");
});

test("mutual se mapea correctamente", () => {
  const result = mapWorkeraAbsence(
    { employee_id: "E-1", type: "TEST_MUTUAL", start_date: "2026-08-10", end_date: "2026-08-20" },
    { typeMapping: TYPE_MAPPING }
  );
  assert.equal(result.type, "MUTUAL");
});

test("tipo externo desconocido produce UNKNOWN_EXTERNAL_STATUS, nunca una categoría adivinada", () => {
  const result = mapWorkeraAbsence(
    { employee_id: "E-1", type: "TIPO_INVENTADO_POR_WORKERA", start_date: "2026-08-10", end_date: "2026-08-10" },
    { typeMapping: TYPE_MAPPING }
  );
  assert.equal(result.type, "UNKNOWN_EXTERNAL_STATUS");
  assert.equal(result.externalType, "TIPO_INVENTADO_POR_WORKERA");
});
