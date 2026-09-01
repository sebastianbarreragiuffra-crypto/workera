import { test } from "node:test";
import assert from "node:assert/strict";
import { holidayWindow } from "./holidays";

test("holidayWindow: rango con holgura hacia adelante y atrás de la fecha base", () => {
  const { from, to } = holidayWindow("2026-09-18");
  assert.equal(from, "2026-09-15"); // 3 días antes
  assert.equal(to, "2026-10-09"); // 21 días después
});

test("holidayWindow: cruza límite de mes correctamente", () => {
  const { from, to } = holidayWindow("2026-12-30");
  assert.equal(from, "2026-12-27");
  assert.equal(to, "2027-01-20");
});
