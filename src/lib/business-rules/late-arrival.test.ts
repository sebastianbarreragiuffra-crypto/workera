import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLateArrivalCandidate } from "./late-arrival";

/**
 * Mock genérico: cada tabla se configura con un handler por operación
 * terminal (`maybeSingle`/`single`). Suficiente para las secuencias fijas
 * que genera late-arrival.ts.
 */
function createMockSupabase(handlers: {
  employee_time_control_policies?: () => { data: unknown; error: unknown };
  schedule_assignments?: () => { data: unknown; error: unknown };
  work_schedule_rules?: () => { data: unknown; error: unknown };
  employees?: () => { data: unknown; error: unknown };
  late_arrival_policies?: () => { data: unknown; error: unknown };
  late_arrival_records_existing?: () => { data: unknown; error: unknown };
  late_arrival_records_insert?: () => { data: unknown; error: unknown };
}) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let isInsert = false;
      const builder = {
        select() {
          return builder;
        },
        insert() {
          isInsert = true;
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
        maybeSingle: async () => {
          if (table === "late_arrival_records") return handlers.late_arrival_records_existing?.() ?? { data: null, error: null };
          return handlers[table as keyof typeof handlers]?.() ?? { data: null, error: null };
        },
        single: async () => {
          if (table === "employees") return handlers.employees?.() ?? { data: null, error: null };
          if (table === "late_arrival_records" && isInsert) {
            return handlers.late_arrival_records_insert?.() ?? { data: { id: "lar-mock" }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
}

const STANDARD_MOCKS = {
  employee_time_control_policies: () => ({ data: null, error: null }),
  employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
  late_arrival_policies: () => ({ data: { id: "policy-1", tolerance_minutes: 0 }, error: null }),
  late_arrival_records_existing: () => ({ data: null, error: null }),
};

test("late arrival general: 07:29 clock-in con scheduled_start 07:30 -> 0 minutos", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "emp-1", "2026-08-17", "att-1", "2026-08-17T11:29:00.000Z" /* 07:29 -04 */);
  assert.equal(result.detectedMinutes, 0);
  assert.equal(result.status, "NO_LATE");
});

test("late arrival general: 07:30 exacto -> 0 minutos", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "emp-1", "2026-08-17", "att-1", "2026-08-17T11:30:00.000Z");
  assert.equal(result.detectedMinutes, 0);
});

test("late arrival general: 07:31 -> 1 minuto", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    late_arrival_records_insert: () => ({ data: { id: "lar-1" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "emp-1", "2026-08-17", "att-1", "2026-08-17T11:31:00.000Z");
  assert.equal(result.detectedMinutes, 1);
  assert.equal(result.status, "GENERATED");
});

test("late arrival Alejandro: 08:29 con scheduled_start 08:30 -> 0", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-alejandro" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:30:00", scheduled_end: "18:00:00" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "alejandro-id", "2026-08-17", "att-1", "2026-08-17T12:29:00.000Z" /* 08:29 -04 */);
  assert.equal(result.detectedMinutes, 0);
});

test("late arrival Alejandro: 08:30 exacto -> 0", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-alejandro" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:30:00", scheduled_end: "18:00:00" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "alejandro-id", "2026-08-17", "att-1", "2026-08-17T12:30:00.000Z");
  assert.equal(result.detectedMinutes, 0);
});

test("late arrival Alejandro: 08:42 -> 12 minutos", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-alejandro" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:30:00", scheduled_end: "18:00:00" }, error: null }),
    late_arrival_records_insert: () => ({ data: { id: "lar-2" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "alejandro-id", "2026-08-17", "att-1", "2026-08-17T12:42:00.000Z");
  assert.equal(result.detectedMinutes, 12);
});

test("late arrival María: 08:00 exacto -> 0", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-maria" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:00:00", scheduled_end: "17:30:00" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "maria-id", "2026-08-17", "att-1", "2026-08-17T12:00:00.000Z" /* 08:00 -04 */);
  assert.equal(result.detectedMinutes, 0);
});

test("late arrival María: 08:07 -> 7 minutos", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-maria" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:00:00", scheduled_end: "17:30:00" }, error: null }),
    late_arrival_records_insert: () => ({ data: { id: "lar-3" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "maria-id", "2026-08-17", "att-1", "2026-08-17T12:07:00.000Z");
  assert.equal(result.detectedMinutes, 7);
});

test("late arrival: trabajador exento nunca genera candidato (Claudio/Michel)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "michel-id", "2026-08-17", "att-1", "2026-08-17T12:07:00.000Z");
  assert.equal(result.status, "EXEMPT");
  assert.equal(result.lateArrivalRecordId, null);
});

test("late arrival: sin clock_in (marcación faltante) -> NO_CLOCK_IN, nunca 'falta' automática", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
  });
  const result = await generateLateArrivalCandidate(mock as never, "emp-1", "2026-08-17", "att-1", null);
  assert.equal(result.status, "NO_CLOCK_IN");
});
