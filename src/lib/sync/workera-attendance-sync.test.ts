import { test } from "node:test";
import assert from "node:assert/strict";
import { syncWorkeraAttendance } from "./workera-attendance-sync";
import { HttpWorkeraClient } from "../workera/http-client";
import type { NormalizedWorkeraAttendanceEvent } from "../workera/types/attendance-event";
import type { ArcotexAuthorizedEmployeeScope } from "../employees/arcotex-authorized-employee-scope";
import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_WORKFORCE_COMPANY_ID,
} from "../shared/workforce-constants";

const COMPANY_ID = "b7000000-0000-4000-8000-000000000001";

/**
 * Mock mínimo de un cliente Supabase estilo PostgREST: cada `.from(table)`
 * arma una cadena `select/insert/update/in/eq/single` y resuelve al hacerle
 * `await` según el `table` + operación, usando los handlers configurados
 * por el test. Registra todas las llamadas en `calls` para poder afirmar
 * "no se escribió nada" en dry-run.
 */
interface MockCall {
  table: string;
  op: "select" | "insert" | "update" | "rpc";
  payload?: unknown;
  in?: unknown;
  eq?: unknown;
}

function createMockSupabase(handlers: {
  employeesSelect?: (codes: unknown) => { data: unknown[] | null; error: { message: string } | null };
  employeesInsert?: (rows: unknown) => { data: unknown[] | null; error: { message: string } | null };
  eventsSelect?: (fingerprints: unknown) => { data: unknown[] | null; error: { message: string } | null };
  eventsInsert?: (rows: unknown) => { error: { message: string } | null };
  eventsUpdate?: (id: unknown, patch: unknown) => { error: { message: string } | null };
  syncRunInsert?: () => { data: { id: string } | null; error: { message: string } | null };
  syncRunUpdate?: (patch: unknown) => { error: { message: string } | null };
  syncRunBegin?: (args: Record<string, unknown>) => { data: string | null; error: { message: string } | null };
  syncRunFinish?: (args: Record<string, unknown>) => { data: boolean; error: { message: string } | null };
  eventUpsert?: (args: Record<string, unknown>) => {
    data: "INSERTED" | "VERSIONED" | "UNCHANGED" | null;
    error: { message: string } | null;
  };
}) {
  const calls: MockCall[] = [];

  function makeBuilder(table: string) {
    let op: "select" | "insert" | "update" | null = null;
    let payload: unknown;
    let inVals: unknown;
    let eqVal: unknown;

    const resolve = () => {
      if (table === "employees" && op === "select") {
        return handlers.employeesSelect?.(inVals) ?? { data: [], error: null };
      }
      if (table === "employees" && op === "insert") {
        return handlers.employeesInsert?.(payload) ?? { data: [], error: null };
      }
      if (table === "workera_attendance_events" && op === "select") {
        return handlers.eventsSelect?.(inVals) ?? { data: [], error: null };
      }
      if (table === "workera_attendance_events" && op === "insert") {
        return handlers.eventsInsert?.(payload) ?? { error: null };
      }
      if (table === "workera_attendance_events" && op === "update") {
        return handlers.eventsUpdate?.(eqVal, payload) ?? { error: null };
      }
      if (table === "sync_runs" && op === "insert") {
        return handlers.syncRunInsert?.() ?? { data: { id: "mock-sync-run-id" }, error: null };
      }
      if (table === "sync_runs" && op === "update") {
        return handlers.syncRunUpdate?.(payload) ?? { error: null };
      }
      return { data: null, error: null };
    };

    const builder = {
      select() {
        if (op !== "insert") op = "select";
        return builder;
      },
      insert(rows: unknown) {
        op = "insert";
        payload = rows;
        calls.push({ table, op, payload: rows });
        return builder;
      },
      update(patch: unknown) {
        op = "update";
        payload = patch;
        calls.push({ table, op, payload: patch });
        return builder;
      },
      in(_col: string, vals: unknown) {
        inVals = vals;
        return builder;
      },
      eq(_col: string, val: unknown) {
        eqVal = val;
        return builder;
      },
      single() {
        return builder;
      },
      then(onResolve: (value: ReturnType<typeof resolve>) => unknown) {
        onResolve(resolve());
      },
    };
    return builder;
  }

  return {
    from: (table: string) => makeBuilder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ table: `rpc:${name}`, op: "rpc", payload: args });
      if (name === "begin_workera_sync_run") {
        return handlers.syncRunBegin?.(args) ?? { data: "mock-sync-run-id", error: null };
      }
      if (name === "finish_workera_sync_run") {
        return handlers.syncRunFinish?.(args) ?? { data: true, error: null };
      }
      if (name === "upsert_workera_attendance_event") {
        return handlers.eventUpsert?.(args) ?? { data: "INSERTED", error: null };
      }
      return { data: null, error: { message: `RPC inesperado: ${name}` } };
    },
    calls,
  };
}

function fakeEvent(overrides: Partial<NormalizedWorkeraAttendanceEvent> = {}): NormalizedWorkeraAttendanceEvent {
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
    ...overrides,
  };
}

function fakeWorkeraClient(events: NormalizedWorkeraAttendanceEvent[]): HttpWorkeraClient {
  return {
    getAllAttendanceEvents: async () => ({ events, pagesFetched: 1, totalResult: events.length }),
  } as unknown as HttpWorkeraClient;
}

function fakeArcotexAuthorizedScope(): ArcotexAuthorizedEmployeeScope {
  const employees = Array.from({ length: ARCOTEX_AUTHORIZED_ROSTER_SIZE }, (_, index) => ({
    id: `11300000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    externalWorkeraId: `AUTORIZADO-${String(index + 1).padStart(3, "0")}`,
  }));
  return {
    employeeIds: employees.map((employee) => employee.id),
    employees,
  };
}

test("rango > 1 día: BLOCKED_RANGE_TOO_LARGE, cero llamadas a Workera", async () => {
  let workeraCalled = false;
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      workeraCalled = true;
      return { events: [], pagesFetched: 0, totalResult: 0 };
    },
  } as unknown as HttpWorkeraClient;

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-01", endDate: "2026-08-05" },
    { workeraClient, supabaseAdmin: createMockSupabase({}) as never }
  );

  assert.equal(result.status, "BLOCKED_RANGE_TOO_LARGE");
  assert.equal(workeraCalled, false);
});

test("evento con employee.code vacío: BLOCKED_UNRESOLVED_EMPLOYEES, cero escrituras", async () => {
  const events = [fakeEvent({ employeeExternalId: "", employee: { ...fakeEvent().employee, code: "" } })];
  const mock = createMockSupabase({});

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "BLOCKED_UNRESOLVED_EMPLOYEES");
  assert.equal(
    mock.calls.filter(
      (c) => (c.op === "insert" || c.op === "update") && c.table !== "sync_runs"
    ).length,
    0
  );
  assert.ok(mock.calls.some((c) => c.table === "rpc:finish_workera_sync_run"));
});

test("dry run: calcula wouldInsert/wouldVersion/wouldUnchanged, CERO escrituras reales", async () => {
  const events = [fakeEvent()];
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }),
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18", dryRun: true },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "DRY_RUN");
  assert.equal(result.wouldInsert, 1);
  assert.equal(result.inserted, 0);
  assert.equal(
    mock.calls.filter((c) => c.op === "insert" || c.op === "update").length,
    0,
    "dry run no debe ejecutar ningún insert/update"
  );
});

test("empleado nuevo: bootstrap crea fila en employees con campos mínimos, nunca sobrescribe uno existente", async () => {
  const events = [fakeEvent({ employeeExternalId: "NEW-001", employee: { ...fakeEvent().employee, code: "NEW-001" } })];
  let employeesInsertPayload: unknown;
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [], error: null }), // no existe todavía
    employeesInsert: (rows) => {
      employeesInsertPayload = rows;
      return { data: [{ id: "emp-new", external_workera_id: "NEW-001" }], error: null };
    },
    eventsSelect: () => ({ data: [], error: null }),
    syncRunInsert: () => ({ data: { id: "sr-1" }, error: null }),
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.employeesBootstrapped, 1);
  assert.ok(Array.isArray(employeesInsertPayload));
  assert.equal((employeesInsertPayload as { external_workera_id: string }[])[0].external_workera_id, "NEW-001");
});

test("ARCOTEX: 45 fichas autorizadas + 43 fichas HOLDING procesan solo el padrón sin bootstrap ni PII", async () => {
  const authorizedScope = fakeArcotexAuthorizedScope();
  const authorizedEvents = authorizedScope.employees.map((employee) => fakeEvent({
    employeeExternalId: employee.externalWorkeraId,
    employee: {
      ...fakeEvent().employee,
      code: employee.externalWorkeraId,
      identification: "",
      name: "",
      lastName: "",
    },
  }));
  const extraCodes = Array.from({ length: 43 }, (_, index) =>
    `HOLDING-EXTRA-${String(index + 1).padStart(3, "0")}`
  );
  const events = [
    ...authorizedEvents,
    ...extraCodes.map((extraCode) => fakeEvent({
      employeeExternalId: extraCode,
      employee: {
        ...fakeEvent().employee,
        code: extraCode,
        identification: "",
        name: "",
        lastName: "",
        employeeStatus: "Holding",
      },
    })),
  ];
  const mock = createMockSupabase({
    syncRunBegin: () => ({ data: "sr-arcotex", error: null }),
  });

  const result = await syncWorkeraAttendance(
    {
      companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
      startDate: "2026-08-18",
      endDate: "2026-08-18",
    },
    {
      workeraClient: fakeWorkeraClient(events),
      supabaseAdmin: mock as never,
      resolveAuthorizedEmployeeScope: async () => authorizedScope,
    }
  );

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.eventsFetched, ARCOTEX_AUTHORIZED_ROSTER_SIZE);
  assert.equal(result.employeesDistinct, ARCOTEX_AUTHORIZED_ROSTER_SIZE);
  assert.equal(result.employeesUnresolved, 0);
  assert.equal(result.employeesBootstrapped, 0);
  assert.equal(result.inserted, ARCOTEX_AUTHORIZED_ROSTER_SIZE);
  assert.equal(mock.calls.filter((call) => call.table === "employees" && call.op === "insert").length, 0);
  const eventWrites = mock.calls.filter((call) => call.table === "rpc:upsert_workera_attendance_event");
  assert.equal(eventWrites.length, ARCOTEX_AUTHORIZED_ROSTER_SIZE);
  const finishCall = mock.calls.find((call) => call.table === "rpc:finish_workera_sync_run");
  assert.equal(
    (finishCall?.payload as { p_records_read?: number } | undefined)?.p_records_read,
    ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    "la ficha HOLDING tampoco entra a las métricas operativas"
  );
  const serialized = JSON.stringify({ result, eventWrites });
  assert.ok(extraCodes.every((code) => !serialized.includes(code)), "la respuesta no expone fichas extra");
  assert.ok(!serialized.includes("Holding"), "la respuesta no expone atributos de la persona extra");
});

test("idempotencia: segunda corrida con el mismo evento vigente lo clasifica UNCHANGED, no inserta", async () => {
  const events = [fakeEvent()];
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }),
    eventsSelect: () => ({
      data: [
        {
          id: "existing-1",
          employee_id: "emp-1",
          external_fingerprint: "WORKERA|90000017|2026-08-18T07:30:00|0|",
          attendance_type_label: "ENTRADA",
          attendance_status: "ACTIVO",
          external_attendance_status: "Activo",
          checksum: "ABC123",
          device_name: "SISTEMA",
          origin: "Sistema",
          origin_code: null,
          source_version: 1,
        },
      ],
      error: null,
    }),
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18", dryRun: true },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.wouldUnchanged, 1);
  assert.equal(result.wouldInsert, 0);
  assert.equal(result.wouldVersion, 0);
});

test("evento MODIFICADO (mismo fingerprint, distinto attendanceStatus): se clasifica VERSION, no UNCHANGED ni INSERT", async () => {
  const events = [fakeEvent({ externalAttendanceStatus: "Modificado" })];
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }),
    eventsSelect: () => ({
      data: [
        {
          id: "existing-1",
          employee_id: "emp-1",
          external_fingerprint: "WORKERA|90000017|2026-08-18T07:30:00|0|",
          attendance_type_label: "ENTRADA",
          attendance_status: "ACTIVO",
          external_attendance_status: "Activo", // distinto al evento fetcheado (Modificado)
          checksum: "ABC123",
          device_name: "SISTEMA",
          origin: "Sistema",
          origin_code: null,
          source_version: 1,
        },
      ],
      error: null,
    }),
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18", dryRun: true },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.wouldVersion, 1);
  assert.equal(result.wouldUnchanged, 0);
  assert.equal(result.wouldInsert, 0);
});

test("versionado real: delega retiro + nueva versión al RPC transaccional", async () => {
  const events = [fakeEvent({ externalAttendanceStatus: "Modificado" })];
  const upsertCalls: Record<string, unknown>[] = [];
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }),
    eventsSelect: () => ({
      data: [
        {
          id: "existing-1",
          employee_id: "emp-1",
          external_fingerprint: "WORKERA|90000017|2026-08-18T07:30:00|0|",
          attendance_type_label: "ENTRADA",
          attendance_status: "ACTIVO",
          external_attendance_status: "Activo",
          checksum: "ABC123",
          device_name: "SISTEMA",
          origin: "Sistema",
          origin_code: null,
          source_version: 1,
        },
      ],
      error: null,
    }),
    syncRunBegin: () => ({ data: "sr-1", error: null }),
    eventUpsert: (args) => {
      upsertCalls.push(args);
      return { data: "VERSIONED", error: null };
    },
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.versioned, 1);
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].p_sync_run_id, "sr-1");
  assert.equal(upsertCalls[0].p_company_id, COMPANY_ID);
});

test("fallo de red de Workera: FAILED y ledger causal cerrado", async () => {
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      throw new Error("ECONNREFUSED");
    },
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({});

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient, supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "FAILED");
  assert.deepEqual(
    mock.calls.filter((call) => call.op === "rpc").map((call) => call.table),
    ["rpc:begin_workera_sync_run", "rpc:finish_workera_sync_run"]
  );
});

test("fallo de schema/validación de Workera: FAILED, mensaje preservado, cero escrituras", async () => {
  const workeraClient = {
    getAllAttendanceEvents: async () => {
      throw new Error("Payload de Workera inválido");
    },
  } as unknown as HttpWorkeraClient;
  const mock = createMockSupabase({});

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient, supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "FAILED");
  assert.match(result.errorMessage ?? "", /inválido/);
  assert.equal(mock.calls.filter((c) => c.op === "insert" || c.op === "update").length, 0);
  assert.ok(mock.calls.some((c) => c.table === "rpc:finish_workera_sync_run"));
});

test("fallo persistiendo eventos: sync_run termina FAILED, no SUCCEEDED parcial", async () => {
  const events = [fakeEvent()];
  const syncRunUpdates: unknown[] = [];
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null }),
    eventsSelect: () => ({ data: [], error: null }),
    syncRunBegin: () => ({ data: "sr-1", error: null }),
    eventUpsert: () => ({ data: null, error: { message: "constraint violation" } }),
    syncRunFinish: (args) => {
      syncRunUpdates.push(args);
      return { data: true, error: null };
    },
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(syncRunUpdates.length, 1);
  assert.equal((syncRunUpdates[0] as { p_status: string }).p_status, "FAILED");
});

test("employee.code solo con espacios en blanco se trata igual que vacío: BLOCKED_UNRESOLVED_EMPLOYEES", async () => {
  const events = [fakeEvent({ employeeExternalId: "   ", employee: { ...fakeEvent().employee, code: "   " } })];
  const mock = createMockSupabase({});

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "BLOCKED_UNRESOLVED_EMPLOYEES");
  assert.equal(mock.calls.filter((c) => c.op === "insert" || c.op === "update").length, 0);
  assert.ok(mock.calls.some((c) => c.table === "rpc:finish_workera_sync_run"));
});

test("mismo employee.code repetido en 2 eventos del día: identidad se resuelve una sola vez, bootstrap crea 1 sola fila (no duplica employees)", async () => {
  const events = [
    fakeEvent({ attendanceTimestampRaw: "2026-08-18T08:00:00" }),
    fakeEvent({ attendanceTimestampRaw: "2026-08-18T17:00:00" }),
  ];
  const bootstrapInsertCalls: unknown[][] = [];
  const mock = createMockSupabase({
    employeesSelect: () => ({ data: [], error: null }),
    employeesInsert: (rows) => {
      bootstrapInsertCalls.push(rows as unknown[]);
      return { data: [{ id: "emp-1", external_workera_id: "90000017" }], error: null };
    },
    eventsSelect: () => ({ data: [], error: null }),
    syncRunInsert: () => ({ data: { id: "sr-1" }, error: null }),
  });

  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: mock as never }
  );

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.employeesDistinct, 1, "2 eventos del mismo empleado cuentan como 1 empleado distinto");
  assert.equal(result.employeesBootstrapped, 1, "el bootstrap crea exactamente 1 fila, no 2");
  assert.equal(bootstrapInsertCalls.length, 1);
  assert.equal((bootstrapInsertCalls[0] as { external_workera_id: string }[]).length, 1);
  assert.equal(result.inserted, 2, "ambos eventos individuales igual se persisten -- Fase 6A nunca colapsa eventos");
});

test("PII: unresolvedEmployeeCodes nunca contiene nombre/apellido/RUT, solo un marcador genérico", async () => {
  const events = [fakeEvent({ employeeExternalId: "", employee: { ...fakeEvent().employee, code: "" } })];
  const result = await syncWorkeraAttendance(
    { companyId: COMPANY_ID, startDate: "2026-08-18", endDate: "2026-08-18" },
    { workeraClient: fakeWorkeraClient(events), supabaseAdmin: createMockSupabase({}) as never }
  );

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("11.111.111-1"), "no debe contener RUT");
  assert.ok(!serialized.includes("Nombre"), "no debe contener nombre");
  assert.ok(!serialized.includes("Apellido"), "no debe contener apellido");
});
