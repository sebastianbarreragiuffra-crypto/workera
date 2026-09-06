import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveDailyAttendanceRecord } from "./daily-attendance";

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: Array<[column: string, value: unknown]>;
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";

function createMockSupabase(handlers: {
  employee_time_control_policies?: () => { data: unknown; error: unknown };
  schedule_assignments?: () => { data: unknown; error: unknown };
  work_schedule_rules?: () => { data: unknown; error: unknown };
  events?: () => { data: unknown; error: unknown };
  attendance_records_existing?: () => { data: unknown; error: unknown };
  attendance_records_insert?: () => { data: unknown; error: unknown };
  update?: (call: UpdateCall) => { data?: unknown; error: unknown };
  rpc?: (call: RpcCall) => { data?: unknown; error: unknown };
}) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      const overridden = handlers.rpc?.({ name, args });
      if (overridden) return Promise.resolve(overridden);
      if (name === "reconcile_workera_attendance_day" && args.p_source_hash !== null) {
        const inserted = handlers.attendance_records_insert?.() ?? { data: { id: "ar-mock" }, error: null };
        const row = inserted.data as { id?: string } | null;
        return Promise.resolve({ data: row?.id ?? null, error: inserted.error });
      }
      return Promise.resolve({ data: name === "reconcile_workera_attendance_day" ? null : true, error: null });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let isInsert = false;
      let updatePatch: Record<string, unknown> | null = null;
      const filters: UpdateCall["filters"] = [];
      const builder = {
        select() {
          return builder;
        },
        insert() {
          isInsert = true;
          return builder;
        },
        update(patch: Record<string, unknown>) {
          updatePatch = patch;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
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
          if (table === "employee_time_control_policies") {
            return handlers.employee_time_control_policies?.() ?? { data: null, error: null };
          }
          if (table === "schedule_assignments") return handlers.schedule_assignments?.() ?? { data: null, error: null };
          if (table === "work_schedule_rules") return handlers.work_schedule_rules?.() ?? { data: null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === "attendance_records" && isInsert) {
            return handlers.attendance_records_insert?.() ?? { data: { id: "ar-mock" }, error: null };
          }
          return { data: null, error: null };
        },
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          if (updatePatch) {
            const response = handlers.update?.({ table, patch: updatePatch, filters }) ?? { data: [], error: null };
            return onResolve({ data: response.data ?? null, error: response.error });
          }
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

test("deriveDailyAttendanceRecord: trabajador exento -> EXEMPT y nunca consulta eventos", async () => {
  let eventsCalled = false;
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" }, error: null }),
    events: () => {
      eventsCalled = true;
      return { data: [], error: null };
    },
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "claudio-id", "2026-08-17", COMPANY_ID);
  assert.equal(result.status, "EXEMPT");
  assert.equal(eventsCalled, false);
});

test("deriveDailyAttendanceRecord: al pasar a exento retira asistencia y cálculos automáticos anteriores sin consultar eventos", async () => {
  let eventsCalled = false;
  const updates: UpdateCall[] = [];
  const rpcCalls: RpcCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({
      data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" },
      error: null,
    }),
    events: () => {
      eventsCalled = true;
      return { data: [], error: null };
    },
    attendance_records_existing: () => ({
      data: {
        id: "ar-before-exemption",
        source: "workera",
        source_hash: "old-hash",
        source_version: 2,
        actual_clock_in: "2026-08-17T11:30:00Z",
        actual_clock_out: "2026-08-17T21:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
    rpc: (call) => {
      rpcCalls.push(call);
      return { data: true, error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-exempt", "2026-08-17", COMPANY_ID);

  assert.equal(result.status, "EXEMPT");
  assert.equal(eventsCalled, false);
  assert.deepEqual(updates, []);
  assert.deepEqual(rpcCalls, [{
    name: "reconcile_workera_attendance_day",
    args: {
      p_company_id: COMPANY_ID,
      p_rule_engine_run_id: null,
      p_employee_id: "emp-exempt",
      p_work_date: "2026-08-17",
      p_actual_clock_in: null,
      p_actual_clock_out: null,
      p_source_hash: null,
    },
  }]);
});

test("deriveDailyAttendanceRecord: al quedar sin horario retira el grafo automático anterior", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: null, error: null }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-before-no-schedule",
        source: "workera",
        source_hash: "old-hash",
        source_version: 2,
        actual_clock_in: "2026-08-17T11:30:00Z",
        actual_clock_out: "2026-08-17T21:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-no-schedule", "2026-08-17", COMPANY_ID);

  assert.equal(result.status, "NO_SCHEDULE_ASSIGNED");
  assert.equal(result.attendanceRecordId, null);
  assert.equal(updates.some((call) => call.table === "attendance_records"), false);
});

test("deriveDailyAttendanceRecord: una transición a exento conserva attendance manual y solo cierra cálculos del motor", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({
      data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" },
      error: null,
    }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-manual-before-exemption",
        source: "manual",
        source_hash: "manual-hash",
        source_version: 3,
        actual_clock_in: "2026-08-17T11:30:00Z",
        actual_clock_out: "2026-08-17T21:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-exempt", "2026-08-17", COMPANY_ID);

  assert.equal(result.status, "EXEMPT");
  assert.equal(updates.some((call) => call.table === "attendance_status_records"), false);
  assert.equal(updates.some((call) => call.table === "attendance_records"), false);
});

test("deriveDailyAttendanceRecord: día sin turno -> DAY_OFF, nunca genera una fila (evita falsa 'falta' en fin de semana)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: null, scheduled_end: null }, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22", COMPANY_ID);
  assert.equal(result.status, "DAY_OFF");
  assert.equal(result.attendanceRecordId, null);
});

test("deriveDailyAttendanceRecord: un día antes trabajado que ahora es descanso sin eventos cierra todo el grafo calculado", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: null, error: null }),
    events: () => ({ data: [], error: null }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-stale",
        source: "workera",
        source_hash: "old-hash",
        source_version: 1,
        actual_clock_in: "2026-08-22T12:00:00Z",
        actual_clock_out: "2026-08-22T16:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22", COMPANY_ID);

  assert.equal(result.status, "DAY_OFF");
  assert.equal(result.attendanceRecordId, null);
  assert.deepEqual(
    updates.map((call) => call.table),
    []
  );
  assert.equal(updates.some((call) => call.table === "attendance_records"), false);
});

test("deriveDailyAttendanceRecord: feriado que perdió sus eventos también cierra la asistencia derivada vigente", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({ data: [], error: null }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-stale-holiday",
        source: "workera",
        source_hash: "old-hash",
        source_version: 3,
        actual_clock_in: "2026-09-18T12:00:00Z",
        actual_clock_out: "2026-09-18T15:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-09-18", COMPANY_ID, true);

  assert.equal(result.status, "HOLIDAY");
  assert.equal(updates.some((call) => call.table === "attendance_records"), false);
});

test("deriveDailyAttendanceRecord: solo eventos de descanso en día libre -> SKIPPED_NO_EVENTS y reconcilia datos obsoletos", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: null, error: null }),
    events: () => ({
      data: [
        { attendance_type_code: 4, attendance_timestamp_interpreted: "2026-08-22T15:00:00Z", attendance_timestamp_raw: "2026-08-22T11:00:00", external_fingerprint: "break-start" },
        { attendance_type_code: 5, attendance_timestamp_interpreted: "2026-08-22T15:30:00Z", attendance_timestamp_raw: "2026-08-22T11:30:00", external_fingerprint: "break-end" },
      ],
      error: null,
    }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-stale-breaks",
        source: "workera",
        source_hash: "old-hash",
        source_version: 2,
        actual_clock_in: "2026-08-22T12:00:00Z",
        actual_clock_out: "2026-08-22T16:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22", COMPANY_ID);

  assert.equal(result.status, "SKIPPED_NO_EVENTS");
  assert.equal(result.attendanceRecordId, null);
  assert.deepEqual(updates, []);
});

test("deriveDailyAttendanceRecord: asistencia manual se conserva aunque Workera ya no entregue eventos", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: null, error: null }),
    events: () => ({ data: [], error: null }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-manual",
        source: "manual",
        source_hash: "manual-hash",
        source_version: 4,
        actual_clock_in: "2026-08-22T12:00:00Z",
        actual_clock_out: "2026-08-22T16:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22", COMPANY_ID);

  assert.deepEqual(result, {
    status: "UNCHANGED",
    attendanceRecordId: "ar-manual",
    clockIn: "2026-08-22T12:00:00Z",
    clockOut: "2026-08-22T16:00:00Z",
  });
  assert.deepEqual(updates, []);
});

test("deriveDailyAttendanceRecord: si falla la reconciliación atómica, no ejecuta DML parcial", async () => {
  const updates: UpdateCall[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: null, error: null }),
    events: () => ({ data: [], error: null }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-stale",
        source: "workera",
        source_hash: "old-hash",
        source_version: 1,
        actual_clock_in: "2026-08-22T12:00:00Z",
        actual_clock_out: "2026-08-22T16:00:00Z",
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
    rpc: () => ({ data: null, error: { message: "db unavailable" } }),
  });

  await assert.rejects(
    deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22", COMPANY_ID),
    /fallo reconciliando el día: db unavailable/
  );
  assert.deepEqual(updates, []);
});

test("deriveDailyAttendanceRecord: día sin turno con marcaciones sí deriva la jornada extraordinaria", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: null, error: null }),
    events: () => ({
      data: [
        { attendance_type_code: 0, attendance_timestamp_interpreted: "2026-08-22T12:00:00Z", attendance_timestamp_raw: "2026-08-22T08:00:00", external_fingerprint: "weekend-in" },
        { attendance_type_code: 1, attendance_timestamp_interpreted: "2026-08-22T16:00:00Z", attendance_timestamp_raw: "2026-08-22T12:00:00", external_fingerprint: "weekend-out" },
      ],
      error: null,
    }),
    attendance_records_existing: () => ({ data: null, error: null }),
    attendance_records_insert: () => ({ data: { id: "ar-weekend" }, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-22", COMPANY_ID);
  assert.equal(result.status, "DERIVED");
  assert.equal(result.attendanceRecordId, "ar-weekend");
  assert.equal(result.clockIn, "2026-08-22T12:00:00Z");
  assert.equal(result.clockOut, "2026-08-22T16:00:00Z");
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
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17", COMPANY_ID);
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
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17", COMPANY_ID);
  assert.equal(result.status, "DERIVED");
  assert.equal(result.clockIn, null);
  assert.equal(result.clockOut, null);
});

test("deriveDailyAttendanceRecord: al cambiar la fuente retira hojas antes de versionar la asistencia", async () => {
  const updates: UpdateCall[] = [];
  const rpcCalls: RpcCall[] = [];
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({
      data: [
        {
          attendance_type_code: 0,
          attendance_timestamp_interpreted: "2026-08-17T11:40:00Z",
          attendance_timestamp_raw: "2026-08-17T07:40:00",
          external_fingerprint: "new-fingerprint",
        },
      ],
      error: null,
    }),
    attendance_records_existing: () => ({
      data: {
        id: "ar-old",
        source: "workera",
        source_hash: "old-hash",
        source_version: 2,
        actual_clock_in: "2026-08-17T11:30:00Z",
        actual_clock_out: null,
      },
      error: null,
    }),
    update: (call) => {
      updates.push(call);
      return { data: [], error: null };
    },
    rpc: (call) => {
      rpcCalls.push(call);
      return {
        data: call.name === "reconcile_workera_attendance_day" ? "ar-new" : true,
        error: null,
      };
    },
  });

  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17", COMPANY_ID);

  assert.equal(result.status, "DERIVED");
  assert.equal(result.attendanceRecordId, "ar-new");
  assert.deepEqual(updates, []);
  assert.deepEqual(rpcCalls.map((call) => call.name), ["reconcile_workera_attendance_day"]);
  assert.notEqual(rpcCalls[0].args.p_source_hash, null);
});

test("migración final: la raíz Workera se reemplaza o retira atómicamente sin DML service_role lateral", () => {
  const sql = readFileSync(
    "supabase/migrations/20260906210000_payroll_revision_state_integrity.sql",
    "utf8",
  );
  const rpc = sql.slice(
    sql.indexOf("create or replace function public.reconcile_workera_attendance_day"),
    sql.indexOf("-- El guard heredado cubria solo INSERT"),
  );

  assert.match(rpc, /security definer[\s\S]*payroll-source-mutation-v1/);
  assert.match(sql, /create or replace function public\.replace_workera_attendance_record[\s\S]*for update/);
  assert.match(rpc, /update public\.late_arrival_records[\s\S]*update public\.early_departure_records[\s\S]*update public\.overtime_records/);
  assert.match(sql, /max\(ar\.source_version\)[\s\S]*set is_current = false[\s\S]*insert into public\.attendance_records/);
  assert.match(sql, /revoke insert, update, delete on public\.attendance_records from service_role/);
  assert.match(sql, /grant execute on function public\.reconcile_workera_attendance_day[\s\S]*to service_role/);
  assert.match(sql, /revoke execute on function public\.replace_workera_attendance_record[\s\S]*from service_role/);
});

test("deriveDailyAttendanceRecord: mismo conjunto de eventos que la versión vigente -> UNCHANGED, no reinserta", async () => {
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({
      data: [{ attendance_type_code: 0, attendance_timestamp_interpreted: "2026-08-17T11:35:00+00:00", attendance_timestamp_raw: "x", external_fingerprint: "fp-1" }],
      error: null,
    }),
    attendance_records_existing: () => ({
      data: { id: "ar-existing", source_hash: createHash("sha256").update("fp-1|ACTIVO|v1").digest("hex"), source_version: 1 },
      error: null,
    }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17", COMPANY_ID);
  assert.equal(result.status, "UNCHANGED");
  assert.equal(result.attendanceRecordId, "ar-existing");
});

test("deriveDailyAttendanceRecord: sin schedule_assignment vigente -> NO_SCHEDULE_ASSIGNED, nunca asume el horario general", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: null, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-08-17", COMPANY_ID);
  assert.equal(result.status, "NO_SCHEDULE_ASSIGNED");
});

// --- MB-6: feriados legales ---

test("deriveDailyAttendanceRecord: feriado SIN eventos -> HOLIDAY, nunca crea attendance_record ni bandera de tarjeta no marcada", async () => {
  let insertCalled = false;
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({ data: [], error: null }),
    attendance_records_insert: () => {
      insertCalled = true;
      return { data: { id: "ar-x" }, error: null };
    },
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-09-18", COMPANY_ID, true);
  assert.equal(result.status, "HOLIDAY");
  assert.equal(result.attendanceRecordId, null);
  assert.equal(insertCalled, false);
});

test("deriveDailyAttendanceRecord: feriado TRABAJADO (con eventos) -> se deriva normal, para pagar HH100", async () => {
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({
      data: [
        { attendance_type_code: 0, attendance_timestamp_interpreted: "2026-09-18T11:00:00Z", attendance_timestamp_raw: "2026-09-18T07:00:00", external_fingerprint: "fp1" },
        { attendance_type_code: 1, attendance_timestamp_interpreted: "2026-09-18T21:00:00Z", attendance_timestamp_raw: "2026-09-18T17:00:00", external_fingerprint: "fp2" },
      ],
      error: null,
    }),
    attendance_records_existing: () => ({ data: null, error: null }),
    attendance_records_insert: () => ({ data: { id: "ar-holiday" }, error: null }),
  });
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-09-18", COMPANY_ID, true);
  assert.equal(result.status, "DERIVED");
  assert.equal(result.attendanceRecordId, "ar-holiday");
  assert.ok(result.clockIn);
  assert.ok(result.clockOut);
});

test("deriveDailyAttendanceRecord: sin la marca isHoliday, un feriado se procesa como día normal (compatibilidad)", async () => {
  const mock = createMockSupabase({
    ...SCHEDULED_MOCKS,
    events: () => ({ data: [], error: null }),
    attendance_records_existing: () => ({ data: null, error: null }),
    attendance_records_insert: () => ({ data: { id: "ar-normal" }, error: null }),
  });
  // isHoliday por defecto = false
  const result = await deriveDailyAttendanceRecord(mock as never, "emp-1", "2026-09-18", COMPANY_ID);
  assert.equal(result.status, "DERIVED");
});
