import assert from "node:assert/strict";
import test from "node:test";

import { repairArcotexAttendanceStatusesForDate } from "./arcotex-attendance-status-repair-service";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";
const DATE = "2026-08-24";

interface MockEvent {
  employee_id: string;
  external_employee_code: string;
  attendance_timestamp_raw: string;
  attendance_type_code: number;
  attendance_type_label: string;
  attendance_status: string;
  external_attendance_status: string;
  origin: string | null;
  origin_code: string | null;
  device_name: string | null;
  checksum: string | null;
}

interface MockCall {
  kind: "query" | "rpc";
  name: string;
  args?: Record<string, unknown>;
  head?: boolean;
}

interface MockResponse {
  data: unknown;
  error: { code?: string; message?: string } | null;
  count?: number | null;
}

interface MockOptions {
  eventReads: MockEvent[][];
  remainingUnknownCounts?: number[];
  rpc?: (name: string, args: Record<string, unknown>) => MockResponse;
}

function event(overrides: Partial<MockEvent> = {}): MockEvent {
  return {
    employee_id: "employee-1",
    external_employee_code: "workera-1",
    attendance_timestamp_raw: "2026-08-24T08:00:00",
    attendance_type_code: 0,
    attendance_type_label: "Entrada",
    attendance_status: "UNKNOWN_EXTERNAL_STATUS",
    external_attendance_status: "ACTIVO",
    origin: "Reloj",
    origin_code: "DEVICE",
    device_name: "Acceso principal",
    checksum: "checksum-1",
    ...overrides,
  };
}

function createMockClient(options: MockOptions) {
  const calls: MockCall[] = [];
  const eventReads = [...options.eventReads];
  const remainingUnknownCounts = [...(options.remainingUnknownCounts ?? [0])];
  let runSequence = 0;

  function queryBuilder(table: string) {
    let head = false;
    const builder = {
      select(_columns: string, selectOptions?: { count?: string; head?: boolean }) {
        head = selectOptions?.head === true;
        return builder;
      },
      eq() {
        return builder;
      },
      limit() {
        return builder;
      },
      then(
        onFulfilled: (value: MockResponse) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        let response: MockResponse;
        if (table === "companies") {
          response = { data: [{ id: COMPANY_ID }], error: null };
        } else if (table === "workera_attendance_events" && head) {
          response = {
            data: null,
            count: remainingUnknownCounts.shift() ?? 0,
            error: null,
          };
        } else if (table === "workera_attendance_events") {
          const rows = eventReads.shift() ?? [];
          response = { data: rows, count: rows.length, error: null };
        } else {
          response = { data: null, error: { code: "UNEXPECTED_TABLE" } };
        }
        calls.push({ kind: "query", name: table, head });
        return Promise.resolve(response).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return queryBuilder(table);
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<MockResponse> {
      calls.push({ kind: "rpc", name, args });
      if (options.rpc) return options.rpc(name, args);
      if (name === "reclaim_stale_workera_sync_runs") return { data: 0, error: null };
      if (name === "begin_workera_sync_run") {
        runSequence += 1;
        return { data: `sync-run-${runSequence}`, error: null };
      }
      if (name === "upsert_workera_attendance_event") return { data: "VERSIONED", error: null };
      if (name === "finish_workera_sync_run") return { data: true, error: null };
      return { data: null, error: { code: "UNEXPECTED_RPC" } };
    },
  };

  return { client, calls };
}

test("preview permanece de solo lectura y no expone identificadores del evento", async () => {
  const sensitiveMarker = "RUT-PII-NO-IMPRIMIR";
  const mock = createMockClient({
    eventReads: [[event({ external_employee_code: sensitiveMarker, device_name: sensitiveMarker })]],
  });

  const result = await repairArcotexAttendanceStatusesForDate(DATE, false, {
    client: mock.client as never,
  });

  assert.equal(result.kind, "PREVIEW");
  assert.equal(mock.calls.some((call) => call.kind === "rpc"), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitiveMarker, "i"));
});

test("apply toma el lease antes de leer y usa el estado vigente posterior al preview", async () => {
  const mock = createMockClient({
    eventReads: [
      [event({ external_attendance_status: "ACTIVO" })],
      [event({ external_attendance_status: " INACTIVO " })],
    ],
  });

  const preview = await repairArcotexAttendanceStatusesForDate(DATE, false, {
    client: mock.client as never,
  });
  const applied = await repairArcotexAttendanceStatusesForDate(DATE, true, {
    client: mock.client as never,
  });

  assert.equal(preview.kind, "PREVIEW");
  assert.equal(applied.kind, "APPLIED");
  const applyCalls = mock.calls.slice(2);
  assert.deepEqual(
    applyCalls.slice(0, 3).map((call) => `${call.kind}:${call.name}`),
    [
      "query:companies",
      "rpc:reclaim_stale_workera_sync_runs",
      "rpc:begin_workera_sync_run",
    ],
  );
  const eventReadIndex = applyCalls.findIndex(
    (call) => call.kind === "query" && call.name === "workera_attendance_events" && !call.head,
  );
  const beginIndex = applyCalls.findIndex((call) => call.name === "begin_workera_sync_run");
  assert.ok(eventReadIndex > beginIndex, "la lectura usada para mutar debe ocurrir después del lease");
  const upsert = applyCalls.find((call) => call.name === "upsert_workera_attendance_event");
  assert.equal(upsert?.args?.p_attendance_status, "INACTIVO");
});

test("un fallo intermedio cierra FAILED y el reintento procesa solo lo aún desconocido", async () => {
  let upsertAttempt = 0;
  let runSequence = 0;
  const mock = createMockClient({
    eventReads: [
      [event(), event({ employee_id: "employee-2", external_employee_code: "workera-2", checksum: "checksum-2" })],
      [
        event({ attendance_status: "ACTIVO" }),
        event({ employee_id: "employee-2", external_employee_code: "workera-2", checksum: "checksum-2" }),
      ],
    ],
    remainingUnknownCounts: [0],
    rpc(name) {
      if (name === "reclaim_stale_workera_sync_runs") return { data: 0, error: null };
      if (name === "begin_workera_sync_run") {
        runSequence += 1;
        return { data: `sync-run-${runSequence}`, error: null };
      }
      if (name === "upsert_workera_attendance_event") {
        upsertAttempt += 1;
        if (upsertAttempt === 2) {
          return { data: null, error: { code: "40001", message: "RUT-PII-NO-EXPONER" } };
        }
        return { data: "VERSIONED", error: null };
      }
      if (name === "finish_workera_sync_run") return { data: true, error: null };
      return { data: null, error: { code: `UNEXPECTED_${name}` } };
    },
  });

  const first = await repairArcotexAttendanceStatusesForDate(DATE, true, {
    client: mock.client as never,
  });
  const retry = await repairArcotexAttendanceStatusesForDate(DATE, true, {
    client: mock.client as never,
  });

  assert.equal(first.kind, "FAILED");
  if (first.kind === "FAILED") {
    assert.equal(first.errorCode, "40001");
    assert.equal(first.versioned, 1);
    assert.doesNotMatch(JSON.stringify(first), /RUT-PII-NO-EXPONER/);
  }
  assert.equal(retry.kind, "APPLIED");
  if (retry.kind === "APPLIED") {
    assert.equal(retry.versioned, 1);
    assert.equal(retry.alreadyNormalizedEvents, 1);
  }
  const finishes = mock.calls.filter((call) => call.name === "finish_workera_sync_run");
  assert.equal(finishes[0]?.args?.p_status, "FAILED");
  assert.equal(finishes.at(-1)?.args?.p_status, "SUCCEEDED");
});

test("si no se confirma el cierre FAILED devuelve solo un código seguro", async () => {
  const sensitiveMessage = "persona@example.com no debe salir";
  const mock = createMockClient({
    eventReads: [[event()]],
    rpc(name) {
      if (name === "reclaim_stale_workera_sync_runs") return { data: 0, error: null };
      if (name === "begin_workera_sync_run") return { data: "sync-run-1", error: null };
      if (name === "upsert_workera_attendance_event") {
        return { data: null, error: { code: "XX001", message: sensitiveMessage } };
      }
      if (name === "finish_workera_sync_run") return { data: false, error: null };
      return { data: null, error: { code: "UNEXPECTED_RPC" } };
    },
  });

  const result = await repairArcotexAttendanceStatusesForDate(DATE, true, {
    client: mock.client as never,
  });

  assert.equal(result.kind, "FAILED");
  if (result.kind === "FAILED") {
    assert.equal(result.errorCode, "RUN_CLOSE_UNCONFIRMED");
  }
  assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitiveMessage, "i"));
});

test("un estado no reconocido visto bajo lease cierra la corrida como FAILED", async () => {
  const mock = createMockClient({
    eventReads: [[event({ external_attendance_status: "NUEVO" })]],
  });

  const result = await repairArcotexAttendanceStatusesForDate(DATE, true, {
    client: mock.client as never,
  });

  assert.equal(result.kind, "BLOCKED_UNRECOGNIZED_STATUS");
  const finish = mock.calls.find((call) => call.name === "finish_workera_sync_run");
  assert.equal(finish?.args?.p_status, "FAILED");
  assert.equal(mock.calls.some((call) => call.name === "upsert_workera_attendance_event"), false);
});
