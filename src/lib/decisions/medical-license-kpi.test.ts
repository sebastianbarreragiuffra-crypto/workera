import assert from "node:assert/strict";
import { test } from "node:test";
import { getActiveLicenseKpiTone } from "./medical-license-kpi";

test("cero licencias activas usa el estado verde", () => {
  assert.equal(getActiveLicenseKpiTone(0), "healthy");
});

test("una o más licencias activas usa el estado ámbar", () => {
  assert.equal(getActiveLicenseKpiTone(1), "attention");
  assert.equal(getActiveLicenseKpiTone(5), "attention");
});
