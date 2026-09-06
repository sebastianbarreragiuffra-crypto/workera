import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePayrollOvertime } from "./payroll-overtime-rules";

const base = { area: "PRODUCTION" as const, dayOfWeek: 2, isHoliday: false };

test("matriz definitiva de horas extra y bono diario", () => {
  assert.deepEqual(evaluatePayrollOvertime({ ...base, realMinutes: 0, approvedMinutes: 0 }), { rate: "HH50", realMinutes: 0, payableMinutes: 0, bonusClp: 0, blocked: false, warnings: [] });
  assert.equal(evaluatePayrollOvertime({ ...base, realMinutes: 59 }).payableMinutes, 0);
  assert.equal(evaluatePayrollOvertime({ ...base, realMinutes: 60, approvedMinutes: 60 }).bonusClp, 0);
  assert.equal(evaluatePayrollOvertime({ ...base, realMinutes: 119, approvedMinutes: 119 }).bonusClp, 0);
  assert.equal(evaluatePayrollOvertime({ ...base, realMinutes: 120, approvedMinutes: 120 }).bonusClp, 1_000);
  const capped = evaluatePayrollOvertime({ ...base, realMinutes: 121, approvedMinutes: 121 });
  assert.equal(capped.realMinutes, 121);
  assert.equal(capped.payableMinutes, 120);
  assert.equal(capped.bonusClp, 1_000);
  assert.ok(capped.warnings.length > 0);
  assert.equal(evaluatePayrollOvertime({ ...base, realMinutes: 600, approvedMinutes: 600 }).bonusClp, 1_000);
});

test("sábado, festivo y domingo respetan tasa, área y topes", () => {
  for (const area of ["PRODUCTION", "INSTALLATION"] as const) {
    const saturday = evaluatePayrollOvertime({ area, dayOfWeek: 6, isHoliday: false, realMinutes: 180, approvedMinutes: 180 });
    assert.equal(saturday.rate, "HH50"); assert.equal(saturday.payableMinutes, 120);
    const holiday = evaluatePayrollOvertime({ area, dayOfWeek: 6, isHoliday: true, realMinutes: 361, approvedMinutes: 361 });
    assert.equal(holiday.rate, "HH100"); assert.equal(holiday.realMinutes, 361); assert.equal(holiday.payableMinutes, 360);
  }
  const sundayInstallation = evaluatePayrollOvertime({ area: "INSTALLATION", dayOfWeek: 0, isHoliday: true, realMinutes: 620, approvedMinutes: 600 });
  assert.equal(sundayInstallation.payableMinutes, 600); assert.equal(sundayInstallation.rate, "HH100");
  assert.equal(evaluatePayrollOvertime({ area: "PRODUCTION", dayOfWeek: 0, isHoliday: false, realMinutes: 120, approvedMinutes: 120 }).blocked, true);
  assert.equal(evaluatePayrollOvertime({ area: "ADMINISTRATION", dayOfWeek: 1, isHoliday: false, realMinutes: 120, approvedMinutes: 120 }).payableMinutes, 0);
});

test("ningún resultado puede ser negativo y toda HE requiere aprobación", () => {
  assert.equal(evaluatePayrollOvertime({ ...base, realMinutes: -1, approvedMinutes: -5 }).payableMinutes, 0);
  const pending = evaluatePayrollOvertime({ ...base, realMinutes: 120 });
  assert.equal(pending.payableMinutes, 0); assert.equal(pending.blocked, true);
});
