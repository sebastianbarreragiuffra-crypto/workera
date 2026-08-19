import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEarlyDepartureCandidate } from "./early-departure";

function createMockSupabase(handlers: {
  employee_time_control_policies?: () => { data: unknown; error: unknown };
  schedule_assignments?: () => { data: unknown; error: unknown };
  work_schedule_rules?: () => { data: unknown; error: unknown };
  early_departure_records_existing?: () => { data: unknown; error: unknown };
  early_departure_records_insert?: () => { data: unknown; error: unknown };
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
          if (table === "early_departure_records") return handlers.early_departure_records_existing?.() ?? { data: null, error: null };
          return handlers[table as keyof typeof handlers]?.() ?? { data: null, error: null };
        },
        single: async () => {
          if (table === "early_departure_records" && isInsert) {
            return handlers.early_departure_records_insert?.() ?? { data: { id: "edr-mock" }, error: null };
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
  early_departure_records_existing: () => ({ data: null, error: null }),
};

// 2026-08-20 es jueves, 2026-08-21 es viernes (verificado).

test("early departure general jueves: 16:50 -> candidata", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_insert: () => ({ data: { id: "edr-1" }, error: null }),
  });
  const result = await generateEarlyDepartureCandidate(mock as never, "emp-1", "2026-08-20", "att-1", "2026-08-20T20:50:00.000Z" /* 16:50 -04 */);
  assert.equal(result.status, "GENERATED");
  assert.equal(result.detectedMinutes, 10);
});

test("early departure general viernes: 14:49 -> candidata, 14:50 -> normal", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "14:50:00" }, error: null }),
  };

  const early = await generateEarlyDepartureCandidate(
    createMockSupabase({ ...scheduleMocks, early_departure_records_insert: () => ({ data: { id: "edr-2" }, error: null }) }) as never,
    "emp-1",
    "2026-08-21",
    "att-1",
    "2026-08-21T18:49:00.000Z" // 14:49 -04
  );
  assert.equal(early.status, "GENERATED");
  assert.equal(early.detectedMinutes, 1);

  const onTime = await generateEarlyDepartureCandidate(createMockSupabase(scheduleMocks) as never, "emp-1", "2026-08-21", "att-1", "2026-08-21T18:50:00.000Z");
  assert.equal(onTime.status, "NO_EARLY_DEPARTURE");
  assert.equal(onTime.detectedMinutes, 0);
});

test("early departure Alejandro jueves: 17:59 -> candidata, 18:00 -> normal", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-alejandro" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:30:00", scheduled_end: "18:00:00" }, error: null }),
  };
  const early = await generateEarlyDepartureCandidate(
    createMockSupabase({ ...scheduleMocks, early_departure_records_insert: () => ({ data: { id: "edr-3" }, error: null }) }) as never,
    "alejandro-id",
    "2026-08-20",
    "att-1",
    "2026-08-20T21:59:00.000Z" // 17:59 -04
  );
  assert.equal(early.detectedMinutes, 1);

  const onTime = await generateEarlyDepartureCandidate(createMockSupabase(scheduleMocks) as never, "alejandro-id", "2026-08-20", "att-1", "2026-08-20T22:00:00.000Z");
  assert.equal(onTime.detectedMinutes, 0);
});

test("early departure Alejandro viernes: 15:49 -> candidata, 15:50 -> normal", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-alejandro" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:30:00", scheduled_end: "15:50:00" }, error: null }),
  };
  const early = await generateEarlyDepartureCandidate(
    createMockSupabase({ ...scheduleMocks, early_departure_records_insert: () => ({ data: { id: "edr-4" }, error: null }) }) as never,
    "alejandro-id",
    "2026-08-21",
    "att-1",
    "2026-08-21T19:49:00.000Z" // 15:49 -04
  );
  assert.equal(early.detectedMinutes, 1);

  const onTime = await generateEarlyDepartureCandidate(createMockSupabase(scheduleMocks) as never, "alejandro-id", "2026-08-21", "att-1", "2026-08-21T19:50:00.000Z");
  assert.equal(onTime.detectedMinutes, 0);
});

test("early departure María jueves: 17:29 -> candidata, 17:30 -> normal", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-maria" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:00:00", scheduled_end: "17:30:00" }, error: null }),
  };
  const early = await generateEarlyDepartureCandidate(
    createMockSupabase({ ...scheduleMocks, early_departure_records_insert: () => ({ data: { id: "edr-5" }, error: null }) }) as never,
    "maria-id",
    "2026-08-20",
    "att-1",
    "2026-08-20T21:29:00.000Z" // 17:29 -04
  );
  assert.equal(early.detectedMinutes, 1);

  const onTime = await generateEarlyDepartureCandidate(createMockSupabase(scheduleMocks) as never, "maria-id", "2026-08-20", "att-1", "2026-08-20T21:30:00.000Z");
  assert.equal(onTime.detectedMinutes, 0);
});

test("early departure María viernes: 15:19 -> candidata, 15:20 -> normal", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-maria" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:00:00", scheduled_end: "15:20:00" }, error: null }),
  };
  const early = await generateEarlyDepartureCandidate(
    createMockSupabase({ ...scheduleMocks, early_departure_records_insert: () => ({ data: { id: "edr-6" }, error: null }) }) as never,
    "maria-id",
    "2026-08-21",
    "att-1",
    "2026-08-21T19:19:00.000Z" // 15:19 -04
  );
  assert.equal(early.detectedMinutes, 1);

  const onTime = await generateEarlyDepartureCandidate(createMockSupabase(scheduleMocks) as never, "maria-id", "2026-08-21", "att-1", "2026-08-21T19:20:00.000Z");
  assert.equal(onTime.detectedMinutes, 0);
});

test("early departure: cumpleaños hoy, sale 12:03 (>=12:00) -> AUTHORIZED_BIRTHDAY_NO_CANDIDATE, deduction 0", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
  };
  // 2026-08-20 es jueves (día hábil).
  const result = await generateEarlyDepartureCandidate(
    createMockSupabase(scheduleMocks) as never,
    "emp-1",
    "2026-08-20",
    "att-1",
    "2026-08-20T16:03:00.000Z", // 12:03 -04
    { birthMonth: 8, birthDay: 20 }
  );
  assert.equal(result.status, "AUTHORIZED_BIRTHDAY_NO_CANDIDATE");
  assert.equal(result.detectedMinutes, 0);
  assert.equal(result.earlyDepartureRecordId, null);
});

test("early departure: cumpleaños hoy, sale 11:15 (antes de las 12:00) -> sigue siendo candidata normal (PASO 32)", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_insert: () => ({ data: { id: "edr-7" }, error: null }),
  };
  const result = await generateEarlyDepartureCandidate(
    createMockSupabase(scheduleMocks) as never,
    "emp-1",
    "2026-08-20",
    "att-1",
    "2026-08-20T15:15:00.000Z", // 11:15 -04
    { birthMonth: 8, birthDay: 20 }
  );
  assert.equal(result.status, "GENERATED");
  assert.equal(result.detectedMinutes, 345); // 17:00 - 11:15 = 5h45m
});

test("early departure: cumpleaños en sábado -> la autorización NO aplica, evalúa normal (aunque no genere sábado sin turno)", async () => {
  const result = await generateEarlyDepartureCandidate(
    createMockSupabase({
      employee_time_control_policies: () => ({ data: null, error: null }),
      schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
      work_schedule_rules: () => ({ data: { scheduled_start: null, scheduled_end: null }, error: null }),
    }) as never,
    "emp-1",
    "2026-08-22", // sábado
    "att-1",
    "2026-08-22T16:00:00.000Z",
    { birthMonth: 8, birthDay: 22 }
  );
  assert.equal(result.status, "DAY_OFF");
});

test("early departure: trabajador exento nunca genera candidato", async () => {
  const result = await generateEarlyDepartureCandidate(
    createMockSupabase({ employee_time_control_policies: () => ({ data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" }, error: null }) }) as never,
    "claudio-id",
    "2026-08-20",
    "att-1",
    "2026-08-20T16:00:00.000Z"
  );
  assert.equal(result.status, "EXEMPT");
});
