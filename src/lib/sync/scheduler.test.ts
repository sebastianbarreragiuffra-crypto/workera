import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runWorkeraSyncForDate,
  runScheduledWorkeraSync,
  rerunWorkeraSync,
  getWorkeraSyncHealth,
  getReconciliationDays,
  MAX_SYNC_ATTEMPTS,
  MAX_MANUAL_SYNC_DAYS,
  RerunAuthorizationError,
} from "./scheduler";
import type { HttpWorkeraClient } from "../workera/http-client";
import { WorkeraTimeoutError, WorkeraNetworkError, WorkeraValidationError } from "../workera/errors";
import type { NormalizedWorkeraAttendanceEvent } from "../workera/types/attendance-event";

/**
 * Mock de supabase-js suficientemente rico para cubrir TODO lo que
 * `syncWorkeraAttendance` (Fase 6A) + `scheduler.ts` (Fase 6B) necesitan:
 * select/insert/update encadenados con in/eq/order/limit/single, y `.rpc()`
 * para reclaim_stale_workera_sync_runs. Registra cada llamada en `calls`
 * para poder afirmar "cero llamadas" en los casos bloqueados/no-retryable.
 */
function createMockSupabase(overrides: {
  employeesSelect?: () => { data: unknown[] | null; error: unknown };
  eventsSelect?: () => { data: unknown[] | null; error: unknown };
  syncRunInsert?: () => { data: { id: string } | null; error: unknown };
  syncRunSelectQueue?: (() => { data: unknown[] | null; error: unknown })[];
  rpc?: (fn: string, args: unknown) => { data: unknown; error: unknown };
} = {}) {
  const calls: { table?: string; fn?: string; op: string }[] = [];
  let syncRunSelectCallIndex = 0;

  function makeBuilder(table: string) {
    let op = "";
    const resolve = (): { data: unknown; error: unknown } => {
      if (table === "employees" && op === "select") return overrides.employeesSelect?.() ?? { data: [], error: null };
      if (table === "employees" && op === "insert") return { data: [{ id: "emp-1", external_workera_id: "X" }], error: null };
      if (table === "workera_attendance_events" && op === "select") return overrides.eventsSelect?.() ?? { data: [], error: null };
      if (table === "workera_attendance_events" && (op === "insert" || op === "update")) return { data: null, error: null };
      if (table === "sync_runs" && op === "insert") return overrides.syncRunInsert?.() ?? { data: { id: "sr-mock" }, error: null };
      if (table === "sync_runs" && op === "update") return { data: null, error: null };
      if (table === "sync_runs" && op === "select") {
        const handler = overrides.syncRunSelectQueue?.[syncRunSelectCallIndex];
        syncRunSelectCallIndex += 1;
        return handler?.() ?? { data: [], error: null };
      }
      return { data: null, error: null };
    };

    const builder = {
      select() {
        if (op !== "insert" && op !== "update") op = "select";
        return builder;
      },
      insert() {
        op = "insert";
        calls.push({ table, op });
        return builder;
      },
      update() {
        op = "update";
        calls.push({ table, op });
        return builder;
      },
      in() {
        return builder;
      },
      eq() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      single() {
        return builder;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then(onResolve: any) {
        if (op === "select") calls.push({ table, op });
        onResolve(resolve());
      },
    };
    return builder;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (table: string) => makeBuilder(table) as any,
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, op: "rpc" });
      return overrides.rpc?.(fn, args) ?? { data: 0, error: null };
    },
    calls,
  };
}

function fakeEvent(): NormalizedWorkeraAttendanceEvent {
  return {
    employeeExternalId: "90000017",
    employee: {
      code: "90000017",
      identification: "11.111.111-1",
      name: "Nombre",
      lastName: "Apellido",
      branchOffice: "Iquique",
      department: "Producción",
      employeeStatus: "Activo",
      companyIdentification: "76.000.000-0",
      companyName: "DEMO WORKERA",
    },
    attendanceTimestampRaw: "2026-08-18T07:30:00",
    attendanceTypeCode: 0,
    attendanceTypeLabel: "ENTRADA",
    attendanceStatus: "ACTIVO",
    externalAttendanceStatus: "Activo",
    origin: "Sistema",
    originCode: null,
    deviceName: "SISTEMA",
    checksum: "ABC123",
  };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// runWorkeraSyncForDate

test("runWorkeraSyncForDate: primer intento exitoso -> attempts=1, sin reintentos", async () => {
  let workeraCallCount = 0;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCallCount += 1;
      return { events: [fakeEvent()], pagesFetched: 1, totalResult: 1 };
    },
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({ employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }) });

  const result = await runWorkeraSyncForDate("2026-08-18", {
    triggeredBy: "CRON",
    deps: { supabaseAdmin: mock as never, workeraClient },
    sleep: noSleep,
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.attempts, 1);
  assert.equal(workeraCallCount, 1);
});

test("runWorkeraSyncForDate: falla retryable, reintenta, segundo intento exitoso -> attempts=2, sleep llamado 1 vez", async () => {
  let workeraCallCount = 0;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCallCount += 1;
      if (workeraCallCount === 1) throw new WorkeraTimeoutError("timeout simulado");
      return { events: [], pagesFetched: 1, totalResult: 0 };
    },
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({});
  let sleepCalls = 0;

  const result = await runWorkeraSyncForDate("2026-08-18", {
    triggeredBy: "CRON",
    deps: { supabaseAdmin: mock as never, workeraClient },
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(workeraCallCount, 2);
  assert.equal(sleepCalls, 1);
  assert.equal(result.attempts, 2);
});

test("runWorkeraSyncForDate: falla NO retryable (payload inválido) -> NO reintenta, attempts=1", async () => {
  let workeraCallCount = 0;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCallCount += 1;
      throw new WorkeraValidationError("payload inválido", []);
    },
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({});
  let sleepCalls = 0;

  const result = await runWorkeraSyncForDate("2026-08-18", {
    triggeredBy: "CRON",
    deps: { supabaseAdmin: mock as never, workeraClient },
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCategory, "WORKERA_PAYLOAD");
  assert.equal(workeraCallCount, 1);
  assert.equal(sleepCalls, 0);
  assert.equal(result.attempts, 1);
});

test(`runWorkeraSyncForDate: fallo retryable persistente agota MAX_SYNC_ATTEMPTS (${MAX_SYNC_ATTEMPTS}) -> FAILED final, nunca infinito`, async () => {
  let workeraCallCount = 0;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCallCount += 1;
      throw new WorkeraNetworkError("red caída simulada");
    },
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({});
  let sleepCalls = 0;

  const result = await runWorkeraSyncForDate("2026-08-18", {
    triggeredBy: "CRON",
    deps: { supabaseAdmin: mock as never, workeraClient },
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(workeraCallCount, MAX_SYNC_ATTEMPTS);
  assert.equal(sleepCalls, MAX_SYNC_ATTEMPTS - 1);
  assert.equal(result.attempts, MAX_SYNC_ATTEMPTS);
});

test("runWorkeraSyncForDate: ALREADY_RUNNING (23505 en sync_runs) -> no reintenta", async () => {
  const workeraClient = {
    getAllAttendanceEvents: async () => ({ events: [fakeEvent()], pagesFetched: 1, totalResult: 1 }),
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }),
    syncRunInsert: () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
  });

  const result = await runWorkeraSyncForDate("2026-08-18", {
    triggeredBy: "CRON",
    deps: { supabaseAdmin: mock as never, workeraClient },
    sleep: noSleep,
  });

  assert.equal(result.status, "ALREADY_RUNNING");
  assert.equal(result.errorCategory, "CONCURRENCY");
  assert.equal(result.attempts, 1);
});

test("runWorkeraSyncForDate: llama a reclaim_stale_workera_sync_runs antes de intentar", async () => {
  const workeraClient = {
    getAllAttendanceEvents: async () => ({ events: [], pagesFetched: 0, totalResult: 0 }),
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({});

  await runWorkeraSyncForDate("2026-08-18", {
    triggeredBy: "CRON",
    deps: { supabaseAdmin: mock as never, workeraClient },
    sleep: noSleep,
  });

  const rpcCalls = mock.calls.filter((c) => c.fn === "reclaim_stale_workera_sync_runs");
  assert.equal(rpcCalls.length, 1);
});

// ---------------------------------------------------------------------------
// runScheduledWorkeraSync

test("runScheduledWorkeraSync: WORKERA_SYNC_ENABLED != 'true' -> enabled=false, CERO llamadas a Workera", async () => {
  const original = process.env.WORKERA_SYNC_ENABLED;
  delete process.env.WORKERA_SYNC_ENABLED;
  try {
    let workeraCalled = false;
    const workeraClient = {
      getAllAttendanceEvents: async () => {
        workeraCalled = true;
        return { events: [], pagesFetched: 0, totalResult: 0 };
      },
    } as unknown as HttpWorkeraClient;

    const summary = await runScheduledWorkeraSync({
      now: new Date("2026-08-20T10:00:00Z"),
      deps: { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
      sleep: noSleep,
    });

    assert.equal(summary.enabled, false);
    assert.equal(summary.targetDate, "2026-08-19");
    assert.equal(workeraCalled, false);
    assert.deepEqual(summary.results, {});
  } finally {
    if (original === undefined) delete process.env.WORKERA_SYNC_ENABLED;
    else process.env.WORKERA_SYNC_ENABLED = original;
  }
});

test("runScheduledWorkeraSync: enabled=true resuelve D-1 + ventana de reconciliación y sincroniza cada fecha", async () => {
  const originalEnabled = process.env.WORKERA_SYNC_ENABLED;
  const originalWindow = process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
  process.env.WORKERA_SYNC_ENABLED = "true";
  process.env.WORKERA_SYNC_RECONCILIATION_DAYS = "1";
  try {
    const requestedDates: string[] = [];
    const workeraClient = {
      getAllAttendanceEvents: async (params: { start: string }) => {
        requestedDates.push(params.start);
        return { events: [], pagesFetched: 0, totalResult: 0 };
      },
    } as unknown as HttpWorkeraClient;

    const summary = await runScheduledWorkeraSync({
      now: new Date("2026-08-20T10:00:00Z"),
      deps: { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
      sleep: noSleep,
    });

    assert.equal(summary.enabled, true);
    assert.equal(summary.targetDate, "2026-08-19");
    assert.deepEqual(summary.reconciliationDates, ["2026-08-18", "2026-08-19"]);
    assert.deepEqual(requestedDates, ["2026-08-18", "2026-08-19"]);
    assert.ok(summary.results["2026-08-18"]);
    assert.ok(summary.results["2026-08-19"]);
  } finally {
    if (originalEnabled === undefined) delete process.env.WORKERA_SYNC_ENABLED;
    else process.env.WORKERA_SYNC_ENABLED = originalEnabled;
    if (originalWindow === undefined) delete process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
    else process.env.WORKERA_SYNC_RECONCILIATION_DAYS = originalWindow;
  }
});

test("getReconciliationDays: default 2 si no está configurado", () => {
  const original = process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
  delete process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
  try {
    assert.equal(getReconciliationDays(), 2);
  } finally {
    if (original === undefined) delete process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
    else process.env.WORKERA_SYNC_RECONCILIATION_DAYS = original;
  }
});

test("getReconciliationDays: valor negativo o no-entero lanza error explícito", () => {
  const original = process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
  try {
    process.env.WORKERA_SYNC_RECONCILIATION_DAYS = "-1";
    assert.throws(() => getReconciliationDays(), /WORKERA_SYNC_RECONCILIATION_DAYS/);
    process.env.WORKERA_SYNC_RECONCILIATION_DAYS = "abc";
    assert.throws(() => getReconciliationDays(), /WORKERA_SYNC_RECONCILIATION_DAYS/);
  } finally {
    if (original === undefined) delete process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
    else process.env.WORKERA_SYNC_RECONCILIATION_DAYS = original;
  }
});

// ---------------------------------------------------------------------------
// rerunWorkeraSync (Fase 6B, PASO 8/9/34/36)

test("rerunWorkeraSync: rol no autorizado (authorize lanza) -> propaga el error, CERO syncs", async () => {
  let workeraCalled = false;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCalled = true;
      return { events: [], pagesFetched: 0, totalResult: 0 };
    },
  } as unknown as HttpWorkeraClient;

  await assert.rejects(
    () =>
      rerunWorkeraSync(
        { startDate: "2026-08-18", endDate: "2026-08-18" },
        { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
        noSleep,
        async () => {
          throw new RerunAuthorizationError("Esta operación requiere uno de estos roles: SUPER_ADMIN, ADMIN_RRHH.");
        }
      ),
    RerunAuthorizationError
  );
  assert.equal(workeraCalled, false);
});

test("rerunWorkeraSync: SUPER_ADMIN autorizado -> ejecuta el rerun", async () => {
  const workeraClient = {
    getAllAttendanceEvents: async () => ({ events: [], pagesFetched: 0, totalResult: 0 }),
  } as unknown as HttpWorkeraClient;

  const result = await rerunWorkeraSync(
    { startDate: "2026-08-18", endDate: "2026-08-18" },
    { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
    noSleep,
    async () => ({ actorId: "admin-1", actorRole: "SUPER_ADMIN" })
  );

  assert.equal(result.actorRole, "SUPER_ADMIN");
  assert.deepEqual(result.dates, ["2026-08-18"]);
  assert.ok(result.results["2026-08-18"]);
});

test("rerunWorkeraSync: ADMIN_RRHH autorizado -> ejecuta el rerun", async () => {
  const workeraClient = {
    getAllAttendanceEvents: async () => ({ events: [], pagesFetched: 0, totalResult: 0 }),
  } as unknown as HttpWorkeraClient;

  const result = await rerunWorkeraSync(
    { startDate: "2026-08-18", endDate: "2026-08-18" },
    { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
    noSleep,
    async () => ({ actorId: "rrhh-1", actorRole: "ADMIN_RRHH" })
  );

  assert.equal(result.actorRole, "ADMIN_RRHH");
});

test(`rerunWorkeraSync: rango > MAX_MANUAL_SYNC_DAYS (${MAX_MANUAL_SYNC_DAYS}) -> lanza error, CERO syncs`, async () => {
  let workeraCalled = false;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCalled = true;
      return { events: [], pagesFetched: 0, totalResult: 0 };
    },
  } as unknown as HttpWorkeraClient;

  await assert.rejects(
    () =>
      rerunWorkeraSync(
        { startDate: "2020-01-01", endDate: "2026-08-20" },
        { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
        noSleep,
        async () => ({ actorId: "admin-1", actorRole: "SUPER_ADMIN" })
      ),
    new RegExp(String(MAX_MANUAL_SYNC_DAYS))
  );
  assert.equal(workeraCalled, false);
});

test("rerunWorkeraSync: rango inválido (endDate antes de startDate) -> lanza error", async () => {
  await assert.rejects(() =>
    rerunWorkeraSync(
      { startDate: "2026-08-20", endDate: "2026-08-18" },
      { supabaseAdmin: createMockSupabase({}) as never },
      noSleep,
      async () => ({ actorId: "admin-1", actorRole: "SUPER_ADMIN" })
    )
  );
});

test("rerunWorkeraSync: recorre cada día del rango, uno por uno", async () => {
  const requestedDates: string[] = [];
  const workeraClient = {
    getAllAttendanceEvents: async (params: { start: string }) => {
      requestedDates.push(params.start);
      return { events: [], pagesFetched: 0, totalResult: 0 };
    },
  } as unknown as HttpWorkeraClient;

  const result = await rerunWorkeraSync(
    { startDate: "2026-08-18", endDate: "2026-08-20" },
    { supabaseAdmin: createMockSupabase({}) as never, workeraClient },
    noSleep,
    async () => ({ actorId: "admin-1", actorRole: "SUPER_ADMIN" })
  );

  assert.deepEqual(result.dates, ["2026-08-18", "2026-08-19", "2026-08-20"]);
  assert.deepEqual(requestedDates, ["2026-08-18", "2026-08-19", "2026-08-20"]);
});

// ---------------------------------------------------------------------------
// getWorkeraSyncHealth

test("getWorkeraSyncHealth: sin ningún SUCCEEDED -> UNKNOWN", async () => {
  const mock = createMockSupabase({ syncRunSelectQueue: [() => ({ data: [], error: null }), () => ({ data: [], error: null }), () => ({ data: [], error: null })] });
  const health = await getWorkeraSyncHealth({ supabaseAdmin: mock as never });
  assert.equal(health.status, "UNKNOWN");
});

test("getWorkeraSyncHealth: hay una corrida RUNNING -> status RUNNING (prioridad sobre lo demás)", async () => {
  const mock = createMockSupabase({
    syncRunSelectQueue: [
      () => ({ data: [{ id: "s1", target_period_start: "2026-08-18", finished_at: "2026-08-18T10:00:00Z" }], error: null }),
      () => ({ data: [], error: null }),
      () => ({ data: [{ id: "s2", target_period_start: "2026-08-19", started_at: "2026-08-19T10:00:00Z" }], error: null }),
    ],
  });
  const health = await getWorkeraSyncHealth({ supabaseAdmin: mock as never });
  assert.equal(health.status, "RUNNING");
  assert.equal(health.currentlyRunning.length, 1);
});

test("getWorkeraSyncHealth: última SUCCEEDED reciente, sin RUNNING ni FAILED más nuevo -> HEALTHY", async () => {
  const recentFinish = new Date(Date.now() - 3_600_000).toISOString(); // hace 1 hora
  const mock = createMockSupabase({
    syncRunSelectQueue: [
      () => ({ data: [{ id: "s1", target_period_start: "2026-08-19", finished_at: recentFinish }], error: null }),
      () => ({ data: [], error: null }),
      () => ({ data: [], error: null }),
    ],
  });
  const health = await getWorkeraSyncHealth({ supabaseAdmin: mock as never });
  assert.equal(health.status, "HEALTHY");
});

test("getWorkeraSyncHealth: última SUCCEEDED más vieja que staleAfterHours -> STALE", async () => {
  const oldFinish = new Date(Date.now() - 40 * 3_600_000).toISOString(); // hace 40 horas
  const mock = createMockSupabase({
    syncRunSelectQueue: [
      () => ({ data: [{ id: "s1", target_period_start: "2026-08-17", finished_at: oldFinish }], error: null }),
      () => ({ data: [], error: null }),
      () => ({ data: [], error: null }),
    ],
  });
  const health = await getWorkeraSyncHealth({ supabaseAdmin: mock as never }, 30);
  assert.equal(health.status, "STALE");
});

test("getWorkeraSyncHealth: SUCCEEDED reciente pero hay un FAILED más nuevo -> DEGRADED", async () => {
  const successAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
  const failureAt = new Date(Date.now() - 1 * 3_600_000).toISOString();
  const mock = createMockSupabase({
    syncRunSelectQueue: [
      () => ({ data: [{ id: "s1", target_period_start: "2026-08-19", finished_at: successAt }], error: null }),
      () => ({ data: [{ id: "s2", target_period_start: "2026-08-20", finished_at: failureAt, error_category: "WORKERA_TIMEOUT" }], error: null }),
      () => ({ data: [], error: null }),
    ],
  });
  const health = await getWorkeraSyncHealth({ supabaseAdmin: mock as never });
  assert.equal(health.status, "DEGRADED");
  assert.equal(health.lastFailure?.errorCategory, "WORKERA_TIMEOUT");
});
