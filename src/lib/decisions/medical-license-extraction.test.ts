import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMedicalLicenseDates } from "./medical-license-extraction";

const bytes = (value: string) => new TextEncoder().encode(value);

test("extrae inicio, término y duración cuando el texto es inequívoco", () => {
  assert.deepEqual(
    extractMedicalLicenseDates(bytes("Fecha de inicio: 20/08/2026 Fecha de término: 22/08/2026 Número de días: 3")),
    { status: "EXTRAIDO", proposedStartDate: "2026-08-20", proposedEndDate: "2026-08-22", proposedDays: 3 },
  );
});

test("marca REQUIERE_REVISION cuando no hay texto interpretable", () => {
  assert.deepEqual(extractMedicalLicenseDates(new Uint8Array([0, 1, 2, 3])), {
    status: "REQUIERE_REVISION",
    proposedStartDate: null,
    proposedEndDate: null,
    proposedDays: null,
  });
});

test("no propone fechas cuando la duración declarada contradice el rango", () => {
  assert.equal(
    extractMedicalLicenseDates(bytes("Inicio: 20/08/2026 Término: 22/08/2026 Días de licencia: 8")).status,
    "REQUIERE_REVISION",
  );
});
