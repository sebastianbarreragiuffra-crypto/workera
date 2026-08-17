import { test } from "node:test";
import assert from "node:assert/strict";
import { rawWorkeraAbsenceRecordSchema } from "./absence";
import { validateWorkeraPayload } from "./validate";

test("payload válido de ausencia pasa la validación", () => {
  const result = validateWorkeraPayload(
    rawWorkeraAbsenceRecordSchema,
    { employee_id: "E-1", type: "VACATION", start_date: "2026-08-10", end_date: "2026-08-15" },
    { operation: "test" }
  );
  assert.equal(result.type, "VACATION");
});

test("type vacío es rechazado", () => {
  assert.throws(() =>
    validateWorkeraPayload(
      rawWorkeraAbsenceRecordSchema,
      { employee_id: "E-1", type: "", start_date: "2026-08-10", end_date: "2026-08-15" },
      { operation: "test" }
    )
  );
});

test("start_date faltante es rechazado", () => {
  assert.throws(() =>
    validateWorkeraPayload(
      rawWorkeraAbsenceRecordSchema,
      { employee_id: "E-1", type: "VACATION", end_date: "2026-08-15" },
      { operation: "test" }
    )
  );
});
