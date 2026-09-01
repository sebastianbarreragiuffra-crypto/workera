import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeScheduleRules,
  buildScheduleAdminRows,
  type RawEmployeeRow,
  type RawAssignmentRow,
  type RawPolicyRow,
} from "./schedule-administration";

// ---------------------------------------------------------------------------
// summarizeScheduleRules

test("summarizeScheduleRules: agrupa días consecutivos con el mismo tramo", () => {
  // "Horario estándar planta" real (seed de Fase 2): L-J 07:30-17:00, V 07:30-14:50.
  const label = summarizeScheduleRules([
    { dayOfWeek: 1, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 2, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 3, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 4, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 5, scheduledStart: "07:30:00", scheduledEnd: "14:50:00" },
  ]);
  assert.equal(label, "L-J 07:30-17:00 · V 07:30-14:50");
});

test("summarizeScheduleRules: un solo día no se escribe como rango", () => {
  const label = summarizeScheduleRules([{ dayOfWeek: 3, scheduledStart: "09:00:00", scheduledEnd: "13:00:00" }]);
  assert.equal(label, "X 09:00-13:00");
});

test("summarizeScheduleRules: los días libres no generan segmento, solo cortan la racha", () => {
  // Lunes y miércoles con el mismo tramo, martes libre: no deben fundirse en "L-X".
  const label = summarizeScheduleRules([
    { dayOfWeek: 1, scheduledStart: "08:00:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 2, scheduledStart: null, scheduledEnd: null },
    { dayOfWeek: 3, scheduledStart: "08:00:00", scheduledEnd: "17:00:00" },
  ]);
  assert.equal(label, "L 08:00-17:00 · X 08:00-17:00");
});

test("summarizeScheduleRules: sin reglas laborales lo dice explícitamente, nunca devuelve vacío", () => {
  assert.equal(summarizeScheduleRules([]), "Sin días laborales definidos");
  assert.equal(
    summarizeScheduleRules([{ dayOfWeek: 0, scheduledStart: null, scheduledEnd: null }]),
    "Sin días laborales definidos"
  );
});

test("summarizeScheduleRules: el domingo se lee al final, no al principio", () => {
  const label = summarizeScheduleRules([
    { dayOfWeek: 0, scheduledStart: "10:00:00", scheduledEnd: "14:00:00" },
    { dayOfWeek: 1, scheduledStart: "08:00:00", scheduledEnd: "17:00:00" },
  ]);
  assert.equal(label, "L 08:00-17:00 · D 10:00-14:00");
});

// ---------------------------------------------------------------------------
// buildScheduleAdminRows

const EMPLOYEES: RawEmployeeRow[] = [
  { id: "emp-1", display_name: "ANA PEREZ", employee_groups: { code: "PRODUCTION" } },
  { id: "emp-2", display_name: "BRUNO SOTO", employee_groups: [{ code: "INSTALLATION" }] },
  { id: "emp-3", display_name: "CARLA DIAZ", employee_groups: null },
];

test("buildScheduleAdminRows: refleja la asignación vigente con su nombre de horario", () => {
  const assignments: RawAssignmentRow[] = [
    { employee_id: "emp-1", work_schedule_id: "sched-std", effective_from: "2026-09-01", work_schedules: { name: "Horario estándar planta" } },
  ];
  const rows = buildScheduleAdminRows(EMPLOYEES, assignments, []);

  assert.equal(rows[0].workScheduleId, "sched-std");
  assert.equal(rows[0].workScheduleName, "Horario estándar planta");
  assert.equal(rows[0].effectiveFrom, "2026-09-01");
  assert.equal(rows[0].timeControl, "NORMAL");
});

test("buildScheduleAdminRows: sin asignación queda en null, nunca inventa el horario general", () => {
  const rows = buildScheduleAdminRows(EMPLOYEES, [], []);
  assert.deepEqual(
    rows.map((r) => r.workScheduleId),
    [null, null, null]
  );
});

test("buildScheduleAdminRows: la exención se refleja con su base legal", () => {
  const policies: RawPolicyRow[] = [
    { employee_id: "emp-2", policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" },
  ];
  const rows = buildScheduleAdminRows(EMPLOYEES, [], policies);

  assert.equal(rows[1].timeControl, "EXEMPT");
  assert.equal(rows[1].legalBasis, "ARTICLE_22");
});

test("buildScheduleAdminRows: una política NORMAL explícita no cuenta como exención", () => {
  const policies: RawPolicyRow[] = [{ employee_id: "emp-1", policy_code: "NORMAL", legal_basis: null }];
  const rows = buildScheduleAdminRows(EMPLOYEES, [], policies);

  assert.equal(rows[0].timeControl, "NORMAL");
  assert.equal(rows[0].legalBasis, null);
});

test("buildScheduleAdminRows: acepta el embed de PostgREST como objeto o como array de 1", () => {
  const rows = buildScheduleAdminRows(EMPLOYEES, [], []);
  assert.equal(rows[0].areaCode, "PRODUCTION"); // objeto
  assert.equal(rows[1].areaCode, "INSTALLATION"); // array
  assert.equal(rows[2].areaCode, null); // sin grupo
});

test("buildScheduleAdminRows: un exento con horario asignado muestra ambas cosas (la exención manda en el motor, pero el dato no se oculta)", () => {
  const assignments: RawAssignmentRow[] = [
    { employee_id: "emp-2", work_schedule_id: "sched-std", effective_from: "2026-09-01", work_schedules: { name: "Horario estándar planta" } },
  ];
  const policies: RawPolicyRow[] = [
    { employee_id: "emp-2", policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" },
  ];
  const rows = buildScheduleAdminRows(EMPLOYEES, assignments, policies);

  assert.equal(rows[1].timeControl, "EXEMPT");
  assert.equal(rows[1].workScheduleName, "Horario estándar planta");
});
