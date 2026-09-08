import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluatePayrollOvertime } from "./payroll-overtime-rules";

const base = { area: "PRODUCTION" as const, dayOfWeek: 2, isHoliday: false };

test("matriz definitiva de horas extra y bono diario", () => {
  assert.deepEqual(evaluatePayrollOvertime({ ...base, realMinutes: 0, approvedMinutes: 0 }), { rate: "HH50", realMinutes: 0, payableMinutes: 0, bonusClp: 0, blocked: false, warnings: [] });
  const belowHour = evaluatePayrollOvertime({ ...base, realMinutes: 59, approvedMinutes: 59 });
  assert.equal(belowHour.payableMinutes, 0);
  assert.equal(belowHour.blocked, true);
  const belowHourApproval = evaluatePayrollOvertime({ ...base, realMinutes: 60, approvedMinutes: 59 });
  assert.equal(belowHourApproval.payableMinutes, 0);
  assert.equal(belowHourApproval.blocked, true);
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

test("migración canónica invalida aprobaciones incompatibles abiertas sin reescribir cierres", () => {
  const migration = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906130000_payroll_overtime_canonical_rules.sql",
  ), "utf8");
  assert.match(migration, /OVERTIME_DECISION_INVALIDATED_BY_CANONICAL_2026_RULES/);
  assert.match(migration, /rp\.status = 'CLOSED'/);
  assert.match(migration, /set is_current = false/);
  assert.match(migration, /effect', 'REQUIRES_NEW_HUMAN_DECISION'/);
});

test("migración fija el bono diario en 120 minutos y $1.000 CLP sin escritura directa", () => {
  const canonical = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906130000_payroll_overtime_canonical_rules.sql",
  ), "utf8");
  const sourceFence = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906150000_payroll_period_atomic_close.sql",
  ), "utf8");

  assert.match(canonical, /threshold_minutes\s*=\s*120/);
  assert.match(canonical, /amount\s*=\s*1000/);
  assert.match(canonical, /currency\s*=\s*'CLP'/);
  assert.match(canonical, /bonus_policies_payroll_2026_canonical_chk/);
  assert.match(canonical, /revoke insert, update, delete on public\.bonus_policies from authenticated/);
  assert.match(canonical, /DAILY_BONUS_NORMALIZED_BY_CANONICAL_2026_RULES/);
  assert.match(sourceFence, /'overtime_policies'/);
  assert.match(sourceFence, /'bonus_policies'/);
});

test("ningún resultado puede ser negativo y toda HE requiere aprobación", () => {
  const negative = evaluatePayrollOvertime({ ...base, realMinutes: -1, approvedMinutes: -5 });
  assert.equal(negative.payableMinutes, 0);
  assert.equal(negative.blocked, true);
  assert.match(negative.warnings.join(" "), /negativos/);
  const pending = evaluatePayrollOvertime({ ...base, realMinutes: 120 });
  assert.equal(pending.payableMinutes, 0); assert.equal(pending.blocked, true);
});
