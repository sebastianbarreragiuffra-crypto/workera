import { test } from "node:test";
import assert from "node:assert/strict";
import { rawWorkeraAttendanceRecordSchema } from "./attendance";
import { validateWorkeraPayload } from "./validate";
import { WorkeraValidationError } from "../errors";

test("payload válido con clock_in/clock_out pasa la validación", () => {
  const result = validateWorkeraPayload(
    rawWorkeraAttendanceRecordSchema,
    { employee_id: "E-1", date: "2026-08-10", clock_in: "2026-08-10T07:30:00-04:00", clock_out: "2026-08-10T17:00:00-04:00" },
    { operation: "test" }
  );
  assert.equal(result.employee_id, "E-1");
});

test("clock_out ausente (marcación faltante) es válido", () => {
  const result = validateWorkeraPayload(
    rawWorkeraAttendanceRecordSchema,
    { employee_id: "E-1", date: "2026-08-10", clock_in: "2026-08-10T07:30:00-04:00", clock_out: null },
    { operation: "test" }
  );
  assert.equal(result.clock_out, null);
});

test("timestamp no interpretable en clock_in es rechazado", () => {
  assert.throws(
    () =>
      validateWorkeraPayload(
        rawWorkeraAttendanceRecordSchema,
        { employee_id: "E-1", date: "2026-08-10", clock_in: "no-es-una-fecha" },
        { operation: "test" }
      ),
    (err: unknown) => err instanceof WorkeraValidationError
  );
});

test("employee_id faltante es rechazado", () => {
  assert.throws(() =>
    validateWorkeraPayload(rawWorkeraAttendanceRecordSchema, { date: "2026-08-10" }, { operation: "test" })
  );
});

test("date faltante es rechazado", () => {
  assert.throws(() =>
    validateWorkeraPayload(rawWorkeraAttendanceRecordSchema, { employee_id: "E-1" }, { operation: "test" })
  );
});
