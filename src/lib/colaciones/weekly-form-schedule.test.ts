import assert from "node:assert/strict";
import { test } from "node:test";
import { getNextFridayMealFormClosing } from "./weekly-form-schedule";

test("programa el cierre para el viernes de la misma semana", () => {
  assert.deepEqual(getNextFridayMealFormClosing(new Date("2026-08-20T15:00:00Z")), {
    closeDate: "2026-08-21",
    closeTime: "13:00",
  });
});

test("mantiene el viernes actual cuando todavía no son las 13:00 en Chile", () => {
  assert.deepEqual(getNextFridayMealFormClosing(new Date("2026-08-21T16:30:00Z")), {
    closeDate: "2026-08-21",
    closeTime: "13:00",
  });
});

test("después del cierre usa el viernes siguiente", () => {
  assert.deepEqual(getNextFridayMealFormClosing(new Date("2026-08-21T17:00:00Z")), {
    closeDate: "2026-08-28",
    closeTime: "13:00",
  });
});
