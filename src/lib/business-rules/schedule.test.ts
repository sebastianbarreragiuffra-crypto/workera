import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveSchedule, resolveTimeControlPolicy } from "./schedule";

/**
 * Mock mínimo: cada tabla resuelve a una respuesta fija vía `.maybeSingle()`
 * -- suficiente porque schedule.ts hace como máximo una consulta por tabla
 * por llamada. Registra qué tablas se consultaron para poder afirmar
 * "no se consultó schedule_assignments cuando ya se sabía EXEMPT", etc.
 */
function createMockSupabase(responses: Record<string, { data: unknown; error: unknown }>) {
  const queriedTables: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      queriedTables.push(table);
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        lte() {
          return builder;
        },
        or() {
          return builder;
        },
        maybeSingle: async () => responses[table] ?? { data: null, error: null },
      };
      return builder;
    },
    queriedTables,
  };
}

test("resolveTimeControlPolicy: sin fila -> NORMAL", async () => {
  const mock = createMockSupabase({ employee_time_control_policies: { data: null, error: null } });
  const result = await resolveTimeControlPolicy(mock as never, "emp-1", "2026-08-17");
  assert.deepEqual(result, { code: "NORMAL" });
});

test("resolveTimeControlPolicy: fila EXEMPT_FROM_TIME_CONTROL -> exento con legal_basis", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" }, error: null },
  });
  const result = await resolveTimeControlPolicy(mock as never, "emp-1", "2026-08-17");
  assert.deepEqual(result, { code: "EXEMPT_FROM_TIME_CONTROL", legalBasis: "ARTICLE_22" });
});

test("resolveEffectiveSchedule: EXEMPT nunca consulta schedule_assignments (PASO 33: precedencia A antes que B)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "emp-1", "2026-08-17");
  assert.deepEqual(result, { kind: "EXEMPT", legalBasis: "NO_MARKING_REQUIRED" });
  assert.ok(!mock.queriedTables.includes("schedule_assignments"));
});

test("resolveEffectiveSchedule: horario general lunes-jueves 07:30-17:00 (PASO 4/53)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-general" }, error: null },
    work_schedule_rules: { data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null },
  });
  // 2026-08-17 es lunes.
  const result = await resolveEffectiveSchedule(mock as never, "emp-1", "2026-08-17");
  assert.deepEqual(result, { kind: "SCHEDULED", workScheduleId: "ws-general", scheduledStart: "07:30:00", scheduledEnd: "17:00:00" });
});

test("resolveEffectiveSchedule: horario general viernes 07:30-14:50", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-general" }, error: null },
    work_schedule_rules: { data: { scheduled_start: "07:30:00", scheduled_end: "14:50:00" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "emp-1", "2026-08-21"); // viernes
  assert.deepEqual(result, { kind: "SCHEDULED", workScheduleId: "ws-general", scheduledStart: "07:30:00", scheduledEnd: "14:50:00" });
});

test("resolveEffectiveSchedule: horario individual Alejandro lunes-jueves 08:30-18:00", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-alejandro" }, error: null },
    work_schedule_rules: { data: { scheduled_start: "08:30:00", scheduled_end: "18:00:00" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "alejandro-id", "2026-08-17");
  assert.deepEqual(result, { kind: "SCHEDULED", workScheduleId: "ws-alejandro", scheduledStart: "08:30:00", scheduledEnd: "18:00:00" });
});

test("resolveEffectiveSchedule: horario individual Alejandro viernes 08:30-15:50", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-alejandro" }, error: null },
    work_schedule_rules: { data: { scheduled_start: "08:30:00", scheduled_end: "15:50:00" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "alejandro-id", "2026-08-21");
  assert.deepEqual(result, { kind: "SCHEDULED", workScheduleId: "ws-alejandro", scheduledStart: "08:30:00", scheduledEnd: "15:50:00" });
});

test("resolveEffectiveSchedule: horario individual María lunes-jueves 08:00-17:30", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-maria" }, error: null },
    work_schedule_rules: { data: { scheduled_start: "08:00:00", scheduled_end: "17:30:00" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "maria-id", "2026-08-17");
  assert.deepEqual(result, { kind: "SCHEDULED", workScheduleId: "ws-maria", scheduledStart: "08:00:00", scheduledEnd: "17:30:00" });
});

test("resolveEffectiveSchedule: horario individual María viernes 08:00-15:20", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-maria" }, error: null },
    work_schedule_rules: { data: { scheduled_start: "08:00:00", scheduled_end: "15:20:00" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "maria-id", "2026-08-21");
  assert.deepEqual(result, { kind: "SCHEDULED", workScheduleId: "ws-maria", scheduledStart: "08:00:00", scheduledEnd: "15:20:00" });
});

test("resolveEffectiveSchedule: trabajador exento (Claudio/Michel) -> EXEMPT", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "michel-id", "2026-08-17");
  assert.deepEqual(result, { kind: "EXEMPT", legalBasis: "ARTICLE_22" });
});

test("resolveEffectiveSchedule: día sin turno (fin de semana) -> DAY_OFF", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: { work_schedule_id: "ws-general" }, error: null },
    work_schedule_rules: { data: { scheduled_start: null, scheduled_end: null }, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "emp-1", "2026-08-22"); // sábado
  assert.deepEqual(result, { kind: "DAY_OFF", workScheduleId: "ws-general" });
});

test("resolveEffectiveSchedule: sin schedule_assignment vigente -> NO_SCHEDULE_ASSIGNED (nunca asume el horario general)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: { data: null, error: null },
    schedule_assignments: { data: null, error: null },
  });
  const result = await resolveEffectiveSchedule(mock as never, "emp-1", "2026-08-17");
  assert.deepEqual(result, { kind: "NO_SCHEDULE_ASSIGNED" });
});
