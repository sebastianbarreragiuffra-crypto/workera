import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEarlyDepartureCandidate, retireCurrentEarlyDepartureCandidate } from "./early-departure";

function createMockSupabase(handlers: {
  employee_time_control_policies?: () => { data: unknown; error: unknown };
  schedule_assignments?: () => { data: unknown; error: unknown };
  work_schedule_rules?: () => { data: unknown; error: unknown };
  early_departure_records_existing?: () => { data: unknown; error: unknown };
  early_departure_records_insert?: () => { data: unknown; error: unknown };
  early_departure_records_update?: (id: string | null) => { data: unknown; error: unknown };
  onInsert?: (row: Record<string, unknown>) => void;
}) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let isInsert = false;
      let isUpdate = false;
      let updatedId: string | null = null;
      const builder = {
        select() {
          return builder;
        },
        insert(row: Record<string, unknown>) {
          isInsert = true;
          handlers.onInsert?.(row);
          return builder;
        },
        update() {
          isUpdate = true;
          return builder;
        },
        eq(column: string, value: unknown) {
          if (column === "id") updatedId = String(value);
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
          if (table === "employee_time_control_policies") {
            return handlers.employee_time_control_policies?.() ?? { data: null, error: null };
          }
          if (table === "schedule_assignments") return handlers.schedule_assignments?.() ?? { data: null, error: null };
          if (table === "work_schedule_rules") return handlers.work_schedule_rules?.() ?? { data: null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === "early_departure_records" && isInsert) {
            return handlers.early_departure_records_insert?.() ?? { data: { id: "edr-mock" }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (table === "early_departure_records" && isUpdate) {
            return resolve(handlers.early_departure_records_update?.(updatedId) ?? { data: null, error: null });
          }
          return resolve({ data: null, error: null });
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

const CURRENT_EARLY = {
  id: "edr-current",
  attendance_record_id: "att-old",
  scheduled_end: "17:00:00",
  actual_end: "2026-08-20T20:50:00.000Z",
  detected_minutes: 10,
  calculation_version: 2,
};

test("early departure: si una corrección deja la salida a tiempo retira el candidato vigente", async () => {
  const retired: Array<string | null> = [];
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_existing: () => ({ data: CURRENT_EARLY, error: null }),
    early_departure_records_update: (id) => {
      retired.push(id);
      return { data: null, error: null };
    },
  });

  const result = await generateEarlyDepartureCandidate(
    mock as never,
    "emp-1",
    "2026-08-20",
    "att-new",
    "2026-08-20T21:00:00.000Z"
  );

  assert.equal(result.status, "NO_EARLY_DEPARTURE");
  assert.deepEqual(retired, ["edr-current"]);
});

test("early departure: exento, día libre y sin horario retiran cualquier candidato anterior", async () => {
  const scenarios = [
    {
      expected: "EXEMPT",
      handlers: {
        employee_time_control_policies: () => ({
          data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" },
          error: null,
        }),
      },
    },
    {
      expected: "DAY_OFF",
      handlers: {
        employee_time_control_policies: () => ({ data: null, error: null }),
        schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
        work_schedule_rules: () => ({ data: null, error: null }),
      },
    },
    {
      expected: "NO_SCHEDULE_ASSIGNED",
      handlers: {
        employee_time_control_policies: () => ({ data: null, error: null }),
        schedule_assignments: () => ({ data: null, error: null }),
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const retired: Array<string | null> = [];
    const mock = createMockSupabase({
      ...scenario.handlers,
      early_departure_records_existing: () => ({ data: CURRENT_EARLY, error: null }),
      early_departure_records_update: (id) => {
        retired.push(id);
        return { data: null, error: null };
      },
    });

    const result = await generateEarlyDepartureCandidate(
      mock as never,
      "emp-1",
      "2026-08-20",
      "att-new",
      "2026-08-20T20:50:00.000Z"
    );
    assert.equal(result.status, scenario.expected);
    assert.deepEqual(retired, ["edr-current"]);
  }
});

test("early departure: perder clock out o quedar autorizado por cumpleaños retira el candidato anterior", async () => {
  const scheduleMocks = {
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
  };

  for (const birthdayCase of [false, true]) {
    const retired: Array<string | null> = [];
    const mock = createMockSupabase({
      ...scheduleMocks,
      early_departure_records_existing: () => ({ data: CURRENT_EARLY, error: null }),
      early_departure_records_update: (id) => {
        retired.push(id);
        return { data: null, error: null };
      },
    });
    const result = await generateEarlyDepartureCandidate(
      mock as never,
      "emp-1",
      "2026-08-20",
      "att-new",
      birthdayCase ? "2026-08-20T16:03:00.000Z" : null,
      birthdayCase ? { birthMonth: 8, birthDay: 20 } : null
    );
    assert.equal(result.status, birthdayCase ? "AUTHORIZED_BIRTHDAY_NO_CANDIDATE" : "NO_CLOCK_OUT");
    assert.deepEqual(retired, ["edr-current"]);
  }
});

test("retireCurrentEarlyDepartureCandidate: permite al orquestador limpiar un feriado trabajado", async () => {
  const retired: Array<string | null> = [];
  const mock = createMockSupabase({
    early_departure_records_existing: () => ({ data: CURRENT_EARLY, error: null }),
    early_departure_records_update: (id) => {
      retired.push(id);
      return { data: null, error: null };
    },
  });

  assert.equal(await retireCurrentEarlyDepartureCandidate(mock as never, "emp-1", "2026-09-18"), true);
  assert.deepEqual(retired, ["edr-current"]);
});

test("early departure: UNCHANGED exige misma asistencia y snapshots causales", async () => {
  let inserted = false;
  let retired = false;
  const exactMock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_existing: () => ({ data: { ...CURRENT_EARLY, attendance_record_id: "att-current" }, error: null }),
    early_departure_records_update: () => {
      retired = true;
      return { data: null, error: null };
    },
    onInsert: () => {
      inserted = true;
    },
  });

  const unchanged = await generateEarlyDepartureCandidate(
    exactMock as never,
    "emp-1",
    "2026-08-20",
    "att-current",
    "2026-08-20T20:50:00.000Z"
  );
  assert.equal(unchanged.status, "UNCHANGED");
  assert.equal(retired, false);
  assert.equal(inserted, false);

  const writes: Record<string, unknown>[] = [];
  const retiredIds: Array<string | null> = [];
  const changedParentMock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_existing: () => ({ data: CURRENT_EARLY, error: null }),
    early_departure_records_update: (id) => {
      retiredIds.push(id);
      return { data: null, error: null };
    },
    onInsert: (row) => writes.push(row),
    early_departure_records_insert: () => ({ data: { id: "edr-v3" }, error: null }),
  });

  const regenerated = await generateEarlyDepartureCandidate(
    changedParentMock as never,
    "emp-1",
    "2026-08-20",
    "att-new",
    "2026-08-20T20:50:00.000Z"
  );
  assert.equal(regenerated.status, "GENERATED");
  assert.deepEqual(retiredIds, ["edr-current"]);
  assert.equal(writes[0].attendance_record_id, "att-new");
  assert.equal(writes[0].calculation_version, 3);
});

test("early departure: mismos minutos con snapshots distintos regeneran el candidato", async () => {
  const writes: Record<string, unknown>[] = [];
  const retiredIds: Array<string | null> = [];
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_existing: () => ({
      data: {
        ...CURRENT_EARLY,
        attendance_record_id: "att-current",
        scheduled_end: "16:50:00",
        actual_end: "2026-08-20T20:40:00.000Z",
      },
      error: null,
    }),
    early_departure_records_update: (id) => {
      retiredIds.push(id);
      return { data: null, error: null };
    },
    onInsert: (row) => writes.push(row),
    early_departure_records_insert: () => ({ data: { id: "edr-snapshot-v3" }, error: null }),
  });

  const result = await generateEarlyDepartureCandidate(
    mock as never,
    "emp-1",
    "2026-08-20",
    "att-current",
    "2026-08-20T20:50:00.000Z"
  );

  assert.equal(result.status, "GENERATED");
  assert.deepEqual(retiredIds, ["edr-current"]);
  assert.equal(writes[0].scheduled_end, "17:00:00");
  assert.equal(writes[0].actual_end, "2026-08-20T20:50:00.000Z");
  assert.equal(writes[0].detected_minutes, 10);
});

test("early departure: un fallo al retirar aborta, nunca devuelve NO_EARLY_DEPARTURE falsamente", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    early_departure_records_existing: () => ({ data: CURRENT_EARLY, error: null }),
    early_departure_records_update: () => ({ data: null, error: { message: "db unavailable" } }),
  });

  await assert.rejects(
    generateEarlyDepartureCandidate(mock as never, "emp-1", "2026-08-20", "att-new", "2026-08-20T21:00:00.000Z"),
    /fallo retirando early_departure_records vigente: db unavailable/
  );
});
