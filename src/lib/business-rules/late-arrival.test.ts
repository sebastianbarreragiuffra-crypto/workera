import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLateArrivalCandidate, retireCurrentLateArrivalCandidate } from "./late-arrival";

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
  late_arrival_records_update?: (id: string | null) => { data: unknown; error: unknown };
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
          if (table === "late_arrival_records") return handlers.late_arrival_records_existing?.() ?? { data: null, error: null };
          if (table === "employee_time_control_policies") {
            return handlers.employee_time_control_policies?.() ?? { data: null, error: null };
          }
          if (table === "schedule_assignments") return handlers.schedule_assignments?.() ?? { data: null, error: null };
          if (table === "work_schedule_rules") return handlers.work_schedule_rules?.() ?? { data: null, error: null };
          if (table === "late_arrival_policies") return handlers.late_arrival_policies?.() ?? { data: null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === "employees") return handlers.employees?.() ?? { data: null, error: null };
          if (table === "late_arrival_records" && isInsert) {
            return handlers.late_arrival_records_insert?.() ?? { data: { id: "lar-mock" }, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (table === "late_arrival_records" && isUpdate) {
            return resolve(handlers.late_arrival_records_update?.(updatedId) ?? { data: null, error: null });
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

const CURRENT_LATE = {
  id: "lar-current",
  attendance_record_id: "att-old",
  scheduled_start: "07:30:00",
  actual_start: "2026-08-17T11:35:00.000Z",
  detected_minutes: 5,
  late_arrival_policy_id: "policy-1",
  calculation_version: 2,
};

test("late arrival: si la corrección deja la entrada a tiempo retira el candidato vigente", async () => {
  const retired: Array<string | null> = [];
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    late_arrival_records_existing: () => ({ data: CURRENT_LATE, error: null }),
    late_arrival_records_update: (id) => {
      retired.push(id);
      return { data: null, error: null };
    },
  });

  const result = await generateLateArrivalCandidate(
    mock as never,
    "emp-1",
    "2026-08-17",
    "att-new",
    "2026-08-17T11:30:00.000Z"
  );

  assert.equal(result.status, "NO_LATE");
  assert.deepEqual(retired, ["lar-current"]);
});

test("late arrival: exento, día libre y sin horario retiran cualquier candidato anterior", async () => {
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
      late_arrival_records_existing: () => ({ data: CURRENT_LATE, error: null }),
      late_arrival_records_update: (id) => {
        retired.push(id);
        return { data: null, error: null };
      },
    });

    const result = await generateLateArrivalCandidate(
      mock as never,
      "emp-1",
      "2026-08-17",
      "att-new",
      "2026-08-17T11:35:00.000Z"
    );
    assert.equal(result.status, scenario.expected);
    assert.deepEqual(retired, ["lar-current"]);
  }
});

test("retireCurrentLateArrivalCandidate: permite al orquestador limpiar un feriado trabajado", async () => {
  const retired: Array<string | null> = [];
  const mock = createMockSupabase({
    late_arrival_records_existing: () => ({ data: CURRENT_LATE, error: null }),
    late_arrival_records_update: (id) => {
      retired.push(id);
      return { data: null, error: null };
    },
  });

  assert.equal(await retireCurrentLateArrivalCandidate(mock as never, "emp-1", "2026-09-18"), true);
  assert.deepEqual(retired, ["lar-current"]);
});

test("late arrival: UNCHANGED exige misma asistencia, horario, marca, minutos y política", async () => {
  let inserted = false;
  let retired = false;
  const exactMock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    late_arrival_records_existing: () => ({ data: { ...CURRENT_LATE, attendance_record_id: "att-current" }, error: null }),
    late_arrival_records_update: () => {
      retired = true;
      return { data: null, error: null };
    },
    onInsert: () => {
      inserted = true;
    },
  });

  const unchanged = await generateLateArrivalCandidate(
    exactMock as never,
    "emp-1",
    "2026-08-17",
    "att-current",
    "2026-08-17T11:35:00.000Z"
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
    late_arrival_records_existing: () => ({ data: CURRENT_LATE, error: null }),
    late_arrival_records_update: (id) => {
      retiredIds.push(id);
      return { data: null, error: null };
    },
    onInsert: (row) => writes.push(row),
    late_arrival_records_insert: () => ({ data: { id: "lar-v3" }, error: null }),
  });

  const regenerated = await generateLateArrivalCandidate(
    changedParentMock as never,
    "emp-1",
    "2026-08-17",
    "att-new",
    "2026-08-17T11:35:00.000Z"
  );
  assert.equal(regenerated.status, "GENERATED");
  assert.deepEqual(retiredIds, ["lar-current"]);
  assert.equal(writes[0].attendance_record_id, "att-new");
  assert.equal(writes[0].calculation_version, 3);
});

test("late arrival: mismos minutos con otra política regeneran el candidato", async () => {
  const writes: Record<string, unknown>[] = [];
  const retiredIds: Array<string | null> = [];
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    late_arrival_records_existing: () => ({
      data: { ...CURRENT_LATE, attendance_record_id: "att-current", late_arrival_policy_id: "policy-anterior" },
      error: null,
    }),
    late_arrival_records_update: (id) => {
      retiredIds.push(id);
      return { data: null, error: null };
    },
    onInsert: (row) => writes.push(row),
    late_arrival_records_insert: () => ({ data: { id: "lar-policy-v3" }, error: null }),
  });

  const result = await generateLateArrivalCandidate(
    mock as never,
    "emp-1",
    "2026-08-17",
    "att-current",
    "2026-08-17T11:35:00.000Z"
  );

  assert.equal(result.status, "GENERATED");
  assert.deepEqual(retiredIds, ["lar-current"]);
  assert.equal(writes[0].late_arrival_policy_id, "policy-1");
  assert.equal(writes[0].detected_minutes, 5);
});

test("late arrival: un fallo al retirar aborta, nunca devuelve NO_LATE falsamente", async () => {
  const mock = createMockSupabase({
    ...STANDARD_MOCKS,
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    late_arrival_records_existing: () => ({ data: CURRENT_LATE, error: null }),
    late_arrival_records_update: () => ({ data: null, error: { message: "db unavailable" } }),
  });

  await assert.rejects(
    generateLateArrivalCandidate(mock as never, "emp-1", "2026-08-17", "att-new", "2026-08-17T11:30:00.000Z"),
    /fallo retirando late_arrival_records vigente: db unavailable/
  );
});
