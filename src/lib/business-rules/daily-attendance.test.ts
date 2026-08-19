import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveDailyAttendanceRecord } from "./daily-attendance";

function createMockSupabase(handlers: {
  employee_time_control_policies?: () => { data: unknown; error: unknown };
  schedule_assignments?: () => { data: unknown; error: unknown };
  work_schedule_rules?: () => { data: unknown; error: unknown };
  events?: () => { data: unknown; error: unknown };
  attendance_records_existing?: () => { data: unknown; error: unknown };
  attendance_records_insert?: () => { data: unknown; error: unknown };
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
        order() {
          return builder;
        },
        maybeSingle: async () => {
          if (table === "attendance_records") return handlers.attendance_records_existing?.() ?? { data: null, error: null };
          return handlers[table as keyof typeof handlers]?.() ?? { data: null, error: null };
        },
        single: async () => {
          if (table === "attendance_records" && isInsert) {
            return handlers.attendance_records_insert?.() ?? { data: { id: "ar-mock" }, error: null };
          }
          return { data: null, error: null };
        },
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          if (table === "workera_attendance_events") return onResolve(handlers.events?.() ?? { data: [], error: null });
          return onResolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
}

const SCHEDULED_MOCKS = {
  employee_time_control_policies: () => ({ data: null, error: null }),
  schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
  work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
};

test("deriveDailyAttendanceRecord: trabajador exento -> EXEMPT, nunca consulta eventos ni escribe nada", async () => {
  let eventsCalled = false;
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" }, error: null }),
    events: () => {
      eventsCalled = true;
      return { data: [], error: null };
    },
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "claudio-id", "2026-08-17");
  assert.equal(result.status, "EXEMPT");
  assert.equal(eventsCalled, false);
});

test("deriveDailyAttendanceRecord: día sin turno -> DAY_OFF, nunca genera una fila (evita falsa 'falta' en fin de semana)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: null, scheduled_end: null }, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22");
  assert.equal(result.status, "DAY_OFF");
  assert.equal(result.attendanceRecordId, null);
});

test("deriveDailyAttendanceRecord: eventos ENTRADA+SALIDA -> deriva clock_in/clock_out correctos, primer entrada y última salida", async () => {
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({
      data: [
        { attendance_type_code: 0, attendance_timestamp_interpreted: "2026-08-17T11:35:00+00:00", attendance_timestamp_raw: "2026-08-17T07:35:00", external_fingerprint: "fp-1" },
        { attendance_type_code: 1, attendance_timestamp_interpreted: "2026-08-17T21:05:00+00:00", attendance_timestamp_raw: "2026-08-17T17:05:00", external_fingerprint: "fp-2" },
      ],
      error: null,
    }),
    attendance_records_existing: () => ({ data: null, error: null }),
    attendance_records_insert: () => ({ data: { id: "ar-1" }, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17");
  assert.equal(result.status, "DERIVED");
  assert.equal(result.clockIn, "2026-08-17T11:35:00+00:00");
  assert.equal(result.clockOut, "2026-08-17T21:05:00+00:00");
});

test("deriveDailyAttendanceRecord: sin eventos (día programado) -> igual deriva una fila con NULLs (para que dispare la alerta de tarjeta no marcada ya existente)", async () => {
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({ data: [], error: null }),
    attendance_records_existing: () => ({ data: null, error: null }),
    attendance_records_insert: () => ({ data: { id: "ar-2" }, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17");
  assert.equal(result.status, "DERIVED");
  assert.equal(result.clockIn, null);
  assert.equal(result.clockOut, null);
});

test("deriveDailyAttendanceRecord: mismo conjunto de eventos que la versión vigente -> UNCHANGED, no reinserta", async () => {
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({
      data: [{ attendance_type_code: 0, attendance_timestamp_interpreted: "2026-08-17T11:35:00+00:00", attendance_timestamp_raw: "x", external_fingerprint: "fp-1" }],
      error: null,
    }),
    attendance_records_existing: () => ({
      data: { id: "ar-existing", source_hash: createHash("sha256").update("fp-1").digest("hex"), source_version: 1 },
      error: null,
    }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17");
  assert.equal(result.status, "UNCHANGED");
  assert.equal(result.attendanceRecordId, "ar-existing");
});

test("deriveDailyAttendanceRecord: sin schedule_assignment vigente -> NO_SCHEDULE_ASSIGNED, nunca asume el horario general", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: null, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17");
  assert.equal(result.status, "NO_SCHEDULE_ASSIGNED");
});
