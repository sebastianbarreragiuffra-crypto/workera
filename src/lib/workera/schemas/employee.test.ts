import { test } from "node:test";
import assert from "node:assert/strict";
import { rawWorkeraEmployeeSchema } from "./employee";
import { validateWorkeraPayload } from "./validate";
import { WorkeraValidationError } from "../errors";

test("payload válido pasa la validación", () => {
  const result = validateWorkeraPayload(
    rawWorkeraEmployeeSchema,
    { id: "E-1", first_name: "Ana", last_name: "Test", active: true, group: "X" },
    { operation: "test" }
  );
  assert.equal(result.id, "E-1");
});

test("campos opcionales ausentes son válidos (rut, group, active)", () => {
  const result = validateWorkeraPayload(
    rawWorkeraEmployeeSchema,
    { id: "E-2", first_name: "Ana" },
    { operation: "test" }
  );
  assert.equal(result.id, "E-2");
  assert.equal(result.rut, undefined);
});

test("id faltante es rechazado con WorkeraValidationError", () => {
  assert.throws(
    () => validateWorkeraPayload(rawWorkeraEmployeeSchema, { first_name: "Sin id" }, { operation: "test" }),
    (err: unknown) => {
      assert.ok(err instanceof WorkeraValidationError);
      assert.ok(err.issues.some((issue) => issue.path === "id"));
      return true;
    }
  );
});

test("id vacío es rechazado", () => {
  assert.throws(() =>
    validateWorkeraPayload(rawWorkeraEmployeeSchema, { id: "" }, { operation: "test" })
  );
});

test("tipo incorrecto en un campo (active como string) es rechazado", () => {
  assert.throws(() =>
    validateWorkeraPayload(
      rawWorkeraEmployeeSchema,
      { id: "E-3", active: "yes" },
      { operation: "test" }
    )
  );
});
