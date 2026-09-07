import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArcotexAttendanceStatusRepairPlan,
  isIsoCalendarDate,
  normalizePreservedAttendanceStatus,
} from "./arcotex-attendance-status-repair";

test("normaliza solo los tres estados documentados conservados por Workera", () => {
  assert.equal(normalizePreservedAttendanceStatus(" Activo "), "ACTIVO");
  assert.equal(normalizePreservedAttendanceStatus("inactivo"), "INACTIVO");
  assert.equal(normalizePreservedAttendanceStatus("MODIFICADO"), "MODIFICADO");
  assert.equal(normalizePreservedAttendanceStatus("estado-nuevo"), null);
});

test("el plan no toca filas ya normalizadas y bloquea desconocidos reales", () => {
  const rows = [
    { id: "1", attendance_status: "UNKNOWN_EXTERNAL_STATUS", external_attendance_status: "Activo" },
    { id: "2", attendance_status: "ACTIVO", external_attendance_status: "Activo" },
    { id: "3", attendance_status: "UNKNOWN_EXTERNAL_STATUS", external_attendance_status: "Inactivo" },
    { id: "4", attendance_status: "UNKNOWN_EXTERNAL_STATUS", external_attendance_status: "NUEVO" },
  ] as const;

  const plan = buildArcotexAttendanceStatusRepairPlan(rows);

  assert.equal(plan.currentEvents, 4);
  assert.equal(plan.unknownEvents, 3);
  assert.equal(plan.unsupportedUnknownEvents, 1);
  assert.equal(plan.alreadyNormalizedEvents, 1);
  assert.deepEqual(plan.targetCounts, { ACTIVO: 1, INACTIVO: 1, MODIFICADO: 0 });
  assert.deepEqual(plan.targets.map((target) => target.row.id), ["1", "3"]);
});

test("valida fechas calendario ISO reales", () => {
  assert.equal(isIsoCalendarDate("2026-08-24"), true);
  assert.equal(isIsoCalendarDate("2026-02-29"), false);
  assert.equal(isIsoCalendarDate("24-08-2026"), false);
});
