import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processAttendanceDay,
  runRuleEngineForDate,
  type ProcessAttendanceDayDeps,
  type ProcessAttendanceDayOptions,
} from "./process-attendance-day";
import type { DeriveDailyAttendanceResult } from "./daily-attendance";
import type { GenerateLateArrivalStatus, GenerateLateArrivalResult } from "./late-arrival";
import type { GenerateEarlyDepartureStatus, GenerateEarlyDepartureResult } from "./early-departure";
import type { GenerateOvertimeCandidateStatus, GenerateOvertimeCandidateResult } from "./overtime-confirmation";

/**
 * Los generadores devuelven `{status, <id>, <minutos>}`. El orquestador solo
 * lee `status`, pero las fábricas construyen el objeto completo para que el
 * mock no se desvíe del contrato real.
 */
const lateResult = (status: GenerateLateArrivalStatus): GenerateLateArrivalResult => ({
  status,
  lateArrivalRecordId: status === "GENERATED" ? "lar-1" : null,
  detectedMinutes: status === "GENERATED" ? 1 : null,
});

const earlyResult = (status: GenerateEarlyDepartureStatus): GenerateEarlyDepartureResult => ({
  status,
  earlyDepartureRecordId: status === "GENERATED" ? "edr-1" : null,
  detectedMinutes: status === "GENERATED" ? 20 : null,
});

const overtimeResult = (status: GenerateOvertimeCandidateStatus): GenerateOvertimeCandidateResult => ({
  status,
  overtimeRecordId: status === "GENERATED" ? "otr-1" : null,
  candidateMinutes: status === "GENERATED" ? 120 : null,
});

const DATE = "2026-09-01";
const COMPANY_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_COMPANY_ID = "20000000-0000-4000-8000-000000000002";

function scoped(options: Omit<ProcessAttendanceDayOptions, "companyId"> = {}): ProcessAttendanceDayOptions {
  return { ...options, companyId: COMPANY_ID };
}

interface EffectivePunchRow {
  attendance_record_id: string;
  effective_clock_in: string | null;
  effective_clock_out: string | null;
}

interface StatusRecordRow {
  id: string;
  employee_id: string;
  attendance_status_id: string;
  source: string;
  source_version: number;
}

/** Registra lo que el motor intentó escribir en `attendance_status_records`. */
interface StatusWrites {
  inserted: { employee_id: string; attendance_status_id: string; source: string }[];
  superseded: string[];
}

interface EmployeeScopeRow {
  id: string;
  company_id: string;
  active: boolean;
  hire_date?: string | null;
  employee_groups?: { code: string } | null;
}

/**
 * Cubre `loadBirthdays`, `loadEffectivePunches` y `applyDailyStatus`; el resto
 * se inyecta por `deps`. Devuelve también un registro de las escrituras para
 * poder afirmar sobre ellas.
 */
function supabaseStub(
  birthdays: { employee_id: string; birth_month: number; birth_day: number }[] = [],
  effectivePunches: EffectivePunchRow[] = [],
  existingStatuses: StatusRecordRow[] = [],
  holidayDates: string[] = [],
  effectivePunchesError: { message: string } | null = null,
  employees: EmployeeScopeRow[] | null = null,
  birthdaysError: { message: string } | null = null
): { client: never; writes: StatusWrites; employeeFilters: Array<{ method: "eq" | "in"; column: string; value: unknown }> } {
  const writes: StatusWrites = { inserted: [], superseded: [] };
  const employeeFilters: Array<{ method: "eq" | "in"; column: string; value: unknown }> = [];

  const dataFor = (table: string): unknown[] => {
    if (table === "attendance_statuses") {
      return [
        { id: "status-P", code: "P" },
        { id: "status-?", code: "?" },
        { id: "status-V", code: "V" },
      ];
    }
    if (table === "attendance_effective_punches") return effectivePunches;
    if (table === "attendance_status_records") return existingStatuses;
    if (table === "employee_birthdays") return birthdays;
    if (table === "holidays") return holidayDates.map((d) => ({ holiday_date: d }));
    if (table === "employees") return employees ?? [];
    return [];
  };

  const client = {
    from: (table: string) => {
      // Builder encadenable y "thenable": cualquier combinación de
      // select/eq/gte/lte/in/order resuelve a los datos de esa tabla.
      const builder: Record<string, unknown> = {};
      let rows = dataFor(table) as Record<string, unknown>[];
      for (const m of ["select", "gte", "lte", "order"]) builder[m] = () => builder;
      builder.eq = (column: string, value: unknown) => {
        if (table === "employees") {
          employeeFilters.push({ method: "eq", column, value });
          if (employees) rows = rows.filter((row) => row[column] === value);
        }
        return builder;
      };
      builder.in = (column: string, value: unknown[]) => {
        if (table === "employees") {
          employeeFilters.push({ method: "in", column, value });
          if (employees) {
            rows = rows.filter((row) => value.includes(row[column]));
          } else if (column === "id") {
            rows = value.map((id) => ({ id, company_id: COMPANY_ID, active: true }));
          }
        } else if (column === "employee_id") {
          // La vista se filtra por employee_id aunque el SELECT productivo no
          // devuelve esa columna. Los fixtures antiguos identifican la fila
          // por attendance_record_id; solo aplica el filtro cuando el fixture
          // expone employee_id explícitamente.
          rows = rows.filter((row) => row.employee_id === undefined || value.includes(row.employee_id));
        }
        return builder;
      };
      builder.range = (from: number, to: number) => {
        rows = rows.slice(from, to + 1);
        return builder;
      };
      builder.then = (resolve: (v: unknown) => void) =>
        resolve(
          table === "attendance_effective_punches" && effectivePunchesError
            ? { data: null, error: effectivePunchesError }
            : table === "employee_birthdays" && birthdaysError
              ? { data: null, error: birthdaysError }
              : { data: rows, error: null }
        );
      return {
        ...builder,
        update: (patch: { is_current?: boolean }) => ({
          eq: async (_col: string, id: string) => {
            if (patch.is_current === false) writes.superseded.push(id);
            return { data: null, error: null };
          },
        }),
        insert: async (row: { employee_id: string; attendance_status_id: string; source: string }) => {
          writes.inserted.push({
            employee_id: row.employee_id,
            attendance_status_id: row.attendance_status_id,
            source: row.source,
          });
          return { data: null, error: null };
        },
      };
    },
  } as never;

  return { client, writes, employeeFilters };
}

/** Azúcar para los tests que no necesitan inspeccionar las escrituras. */
function stub(
  birthdays: { employee_id: string; birth_month: number; birth_day: number }[] = [],
  effectivePunches: EffectivePunchRow[] = []
) {
  return supabaseStub(birthdays, effectivePunches).client;
}

interface ScriptedEmployee {
  attendance: DeriveDailyAttendanceResult;
  late?: GenerateLateArrivalStatus;
  early?: GenerateEarlyDepartureStatus;
  overtime?: GenerateOvertimeCandidateStatus;
  throwOn?: "derive" | "late";
}

function scriptedDeps(script: Record<string, ScriptedEmployee>): ProcessAttendanceDayDeps {
  return {
    deriveDailyAttendanceRecord: (async (_s: unknown, employeeId: string) => {
      const e = script[employeeId];
      if (e.throwOn === "derive") throw new Error(`falla derivando ${employeeId}`);
      return e.attendance;
    }) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],

    generateLateArrivalCandidate: (async (_s: unknown, employeeId: string) => {
      const e = script[employeeId];
      if (e.throwOn === "late") throw new Error(`falla atraso ${employeeId}`);
      return lateResult(e.late ?? "NO_LATE");
    }) as ProcessAttendanceDayDeps["generateLateArrivalCandidate"],

    generateEarlyDepartureCandidate: (async (_s: unknown, employeeId: string) =>
      earlyResult(script[employeeId].early ?? "NO_EARLY_DEPARTURE")) as ProcessAttendanceDayDeps["generateEarlyDepartureCandidate"],

    retireCurrentLateArrivalCandidate: (async () => false) as ProcessAttendanceDayDeps["retireCurrentLateArrivalCandidate"],

    retireCurrentEarlyDepartureCandidate: (async () => false) as ProcessAttendanceDayDeps["retireCurrentEarlyDepartureCandidate"],

    generateOvertimeCandidate: (async (_s: unknown, employeeId: string) =>
      overtimeResult(script[employeeId].overtime ?? "NO_OVERTIME")) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };
}

const derived = (id = "ar-1"): DeriveDailyAttendanceResult => ({
  status: "DERIVED",
  attendanceRecordId: id,
  clockIn: "2026-09-01T11:31:00Z",
  clockOut: "2026-09-01T21:00:00Z",
});

const noRecord = (status: DeriveDailyAttendanceResult["status"]): DeriveDailyAttendanceResult => ({
  status,
  attendanceRecordId: null,
  clockIn: null,
  clockOut: null,
});

test("processAttendanceDay: agrega los candidatos generados por los tres motores", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: derived(), late: "GENERATED" },
    "emp-2": { attendance: derived(), overtime: "GENERATED" },
    "emp-3": { attendance: derived(), early: "GENERATED", late: "GENERATED" },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1", "emp-2", "emp-3"] }, deps);

  assert.equal(result.employeesProcessed, 3);
  assert.equal(result.attendanceDerived, 3);
  assert.equal(result.lateCandidates, 2);
  assert.equal(result.earlyDepartureCandidates, 1);
  assert.equal(result.overtimeCandidates, 1);
  assert.equal(result.failures.length, 0);
});

test("processAttendanceDay: sin attendance_record no invoca ningún generador (exento / día libre / sin horario)", async () => {
  let generatorsCalled = 0;
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({}),
    deriveDailyAttendanceRecord: (async (_s: unknown, employeeId: string) =>
      noRecord(
        employeeId === "exento" ? "EXEMPT" : employeeId === "libre" ? "DAY_OFF" : "NO_SCHEDULE_ASSIGNED"
      )) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
    generateLateArrivalCandidate: (async () => {
      generatorsCalled += 1;
      return lateResult("NO_LATE");
    }) as ProcessAttendanceDayDeps["generateLateArrivalCandidate"],
    generateEarlyDepartureCandidate: (async () => {
      generatorsCalled += 1;
      return earlyResult("NO_EARLY_DEPARTURE");
    }) as ProcessAttendanceDayDeps["generateEarlyDepartureCandidate"],
    generateOvertimeCandidate: (async () => {
      generatorsCalled += 1;
      return overtimeResult("NO_OVERTIME");
    }) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["exento", "libre", "sin-horario"] }, deps);

  assert.equal(generatorsCalled, 0);
  assert.equal(result.exempt, 1);
  assert.equal(result.dayOff, 1);
  assert.equal(result.withoutSchedule, 1);
  assert.equal(result.attendanceDerived, 0);
});

test("processAttendanceDay: `withoutSchedule` es la señal de cobertura incompleta de la marcha blanca", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: derived() },
    "emp-2": { attendance: noRecord("NO_SCHEDULE_ASSIGNED") },
    "emp-3": { attendance: noRecord("NO_SCHEDULE_ASSIGNED") },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1", "emp-2", "emp-3"] }, deps);
  assert.equal(result.withoutSchedule, 2);
});

test("processAttendanceDay: el fallo de un trabajador no cancela a los demás", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: derived(), late: "GENERATED" },
    "emp-roto": { attendance: derived(), throwOn: "derive" },
    "emp-3": { attendance: derived(), overtime: "GENERATED" },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1", "emp-roto", "emp-3"] }, deps);

  assert.equal(result.employeesProcessed, 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].employeeId, "emp-roto");
  // Los otros dos SÍ quedaron procesados: es el punto del aislamiento.
  assert.equal(result.lateCandidates, 1);
  assert.equal(result.overtimeCandidates, 1);
});

test("processAttendanceDay: un trabajador que falla no se cuenta como derivado ni como sin-horario", async () => {
  const deps = scriptedDeps({
    "emp-roto": { attendance: derived(), throwOn: "derive" },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-roto"] }, deps);

  assert.equal(result.attendanceDerived, 0);
  assert.equal(result.withoutSchedule, 0);
  assert.equal(result.failures.length, 1);
});

test("processAttendanceDay: un fallo dentro de un generador también queda aislado", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: derived() },
    "emp-roto": { attendance: derived(), throwOn: "late" },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1", "emp-roto"] }, deps);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /falla atraso/);
});

test("processAttendanceDay: un fallo de generador no publica P/? para una jornada parcialmente recalculada", async () => {
  const { client, writes } = supabaseStub();
  const deps = scriptedDeps({
    "emp-roto": { attendance: derived(), throwOn: "late" },
  });

  const result = await processAttendanceDay(
    client,
    DATE,
    { companyId: COMPANY_ID, employeeIds: ["emp-roto"] },
    deps
  );

  assert.equal(result.failures.length, 1);
  assert.deepEqual(writes.inserted, [], "un cálculo incompleto nunca se presenta como un estado diario cerrado");
});

test("processAttendanceDay: UNCHANGED se cuenta aparte de DERIVED (reprocesar no infla las métricas)", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: { status: "UNCHANGED", attendanceRecordId: "ar-1", clockIn: null, clockOut: null } },
    "emp-2": { attendance: derived() },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1", "emp-2"] }, deps);

  assert.equal(result.attendanceUnchanged, 1);
  assert.equal(result.attendanceDerived, 1);
});

test("processAttendanceDay: UNCHANGED igual corre los generadores (una corrección previa pudo cambiar el candidato)", async () => {
  const deps = scriptedDeps({
    "emp-1": {
      attendance: { status: "UNCHANGED", attendanceRecordId: "ar-1", clockIn: null, clockOut: null },
      late: "GENERATED",
    },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.equal(result.lateCandidates, 1);
});

test("processAttendanceDay: conserva el contador para una política futura aún no configurada", async () => {
  const deps = scriptedDeps({
    "instalacion-1": { attendance: derived(), overtime: "OVERTIME_POLICY_REQUIRES_CONFIRMATION" },
    "produccion-1": { attendance: derived(), overtime: "GENERATED" },
  });

  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["instalacion-1", "produccion-1"] }, deps);

  assert.equal(result.overtimeCandidates, 1);
  assert.equal(result.overtimeRequiresConfirmation, 1);
});

test("processAttendanceDay: el cumpleaños del trabajador llega al generador de salida anticipada", async () => {
  let received: unknown = "no-invocado";
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived() } }),
    generateEarlyDepartureCandidate: (async (
      _s: unknown,
      _e: string,
      _d: string,
      _ar: string,
      _co: string | null,
      birthday: unknown
    ) => {
      received = birthday;
      return earlyResult("NO_EARLY_DEPARTURE");
    }) as ProcessAttendanceDayDeps["generateEarlyDepartureCandidate"],
  };

  await processAttendanceDay(
    stub([{ employee_id: "emp-1", birth_month: 9, birth_day: 1 }]),
    DATE,
    { companyId: COMPANY_ID, employeeIds: ["emp-1"] },
    deps
  );

  assert.deepEqual(received, { birthMonth: 9, birthDay: 1 });
});

test("processAttendanceDay: sin cumpleaños cargado pasa null, nunca un objeto inventado", async () => {
  let received: unknown = "no-invocado";
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived() } }),
    generateEarlyDepartureCandidate: (async (
      _s: unknown,
      _e: string,
      _d: string,
      _ar: string,
      _co: string | null,
      birthday: unknown
    ) => {
      received = birthday;
      return earlyResult("NO_EARLY_DEPARTURE");
    }) as ProcessAttendanceDayDeps["generateEarlyDepartureCandidate"],
  };

  await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.equal(received, null);
});

test("processAttendanceDay: lista vacía es una corrida válida, no un error", async () => {
  const result = await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: [] }, scriptedDeps({}));
  assert.equal(result.employeesProcessed, 0);
  assert.equal(result.failures.length, 0);
});

// ---------------------------------------------------------------------------
// MB-3: la corrección autorizada del jefe manda sobre la marcación cruda

test("processAttendanceDay: usa la marcación EFECTIVA cuando existe una corrección vigente", async () => {
  const recibido: { clockIn: string | null; clockOut: string | null }[] = [];
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived("ar-1") } }),
    generateOvertimeCandidate: (async (
      _s: unknown,
      _e: string,
      _d: string,
      _ar: string,
      clockOut: string | null
    ) => {
      recibido.push({ clockIn: null, clockOut });
      return overtimeResult("GENERATED");
    }) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };

  // El crudo no tiene salida (el trabajador olvidó marcar); la corrección sí.
  const sinSalida: DeriveDailyAttendanceResult = { status: "UNCHANGED", attendanceRecordId: "ar-1", clockIn: "2026-09-01T11:30:00Z", clockOut: null };
  const depsSinSalida: ProcessAttendanceDayDeps = {
    ...deps,
    deriveDailyAttendanceRecord: (async () => sinSalida) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  const result = await processAttendanceDay(
    stub([], [{ attendance_record_id: "ar-1", effective_clock_in: "2026-09-01T11:30:00Z", effective_clock_out: "2026-09-01T22:30:00Z" }]),
    DATE,
    { companyId: COMPANY_ID, employeeIds: ["emp-1"] },
    depsSinSalida
  );

  assert.equal(recibido[0].clockOut, "2026-09-01T22:30:00Z", "el generador debe recibir la salida corregida, no el NULL crudo");
  assert.equal(result.overtimeCandidates, 1, "con la salida corregida el candidato de horas extra sí se genera");
});

test("processAttendanceDay: sin corrección, la marcación efectiva es exactamente la cruda", async () => {
  const recibido: (string | null)[] = [];
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived("ar-1") } }),
    generateOvertimeCandidate: (async (_s: unknown, _e: string, _d: string, _ar: string, clockOut: string | null) => {
      recibido.push(clockOut);
      return overtimeResult("NO_OVERTIME");
    }) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };

  await processAttendanceDay(stub(), DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.equal(recibido[0], "2026-09-01T21:00:00Z");
});

test("processAttendanceDay: una corrección de OTRO attendance_record no contamina a este trabajador", async () => {
  const recibido: (string | null)[] = [];
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived("ar-1") } }),
    generateOvertimeCandidate: (async (_s: unknown, _e: string, _d: string, _ar: string, clockOut: string | null) => {
      recibido.push(clockOut);
      return overtimeResult("NO_OVERTIME");
    }) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };

  await processAttendanceDay(
    stub([], [{ attendance_record_id: "ar-OTRO", effective_clock_in: null, effective_clock_out: "2026-09-01T23:59:00Z" }]),
    DATE,
    { companyId: COMPANY_ID, employeeIds: ["emp-1"] },
    deps
  );

  assert.equal(recibido[0], "2026-09-01T21:00:00Z", "debe seguir usando su propia marcación cruda");
});

test("processAttendanceDay: si falla la vista de marcaciones efectivas aborta, nunca degrada al dato crudo", async () => {
  const { client } = supabaseStub([], [], [], [], { message: "vista temporalmente no disponible" });
  const deps = scriptedDeps({ "emp-1": { attendance: derived("ar-1") } });

  await assert.rejects(
    () => processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps),
    /loadEffectivePunches: fallo leyendo attendance_effective_punches: vista temporalmente no disponible/
  );
});

// ---------------------------------------------------------------------------
// MB-4: código diario de asistencia

test("processAttendanceDay: marca P cuando hubo marcación de entrada", async () => {
  const { client, writes } = supabaseStub();
  const deps = scriptedDeps({ "emp-1": { attendance: derived() } });

  const result = await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);

  assert.deepEqual(writes.inserted, [{ employee_id: "emp-1", attendance_status_id: "status-P", source: "system" }]);
  assert.equal(result.statusesWritten, 1);
});

test("processAttendanceDay: marca '?' cuando era día laboral y no hubo ninguna marcación -- NUNCA F", async () => {
  const { client, writes } = supabaseStub();
  const sinMarcacion: DeriveDailyAttendanceResult = { status: "DERIVED", attendanceRecordId: "ar-1", clockIn: null, clockOut: null };
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: sinMarcacion } }),
    deriveDailyAttendanceRecord: (async () => sinMarcacion) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);

  assert.equal(writes.inserted[0].attendance_status_id, "status-?");
});

test("processAttendanceDay: exento / día libre / sin horario no reciben código diario", async () => {
  const { client, writes } = supabaseStub();
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({}),
    deriveDailyAttendanceRecord: (async (_s: unknown, employeeId: string) =>
      noRecord(
        employeeId === "exento" ? "EXEMPT" : employeeId === "libre" ? "DAY_OFF" : "NO_SCHEDULE_ASSIGNED"
      )) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  const result = await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["exento", "libre", "sin-horario"] }, deps);

  assert.deepEqual(writes.inserted, [], "no hay nada que afirmar sobre un día que no debía tener marcación");
  assert.equal(result.statusesWritten, 0);
});

test("processAttendanceDay: NUNCA pisa un código que puso una persona", async () => {
  // RRHH ya marcó el día como vacaciones. Reprocesar no debe volverlo "?".
  const { client, writes } = supabaseStub(
    [],
    [],
    [{ id: "asr-1", employee_id: "emp-1", attendance_status_id: "status-V", source: "manual", source_version: 1 }]
  );
  const sinMarcacion: DeriveDailyAttendanceResult = { status: "DERIVED", attendanceRecordId: "ar-1", clockIn: null, clockOut: null };
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: sinMarcacion } }),
    deriveDailyAttendanceRecord: (async () => sinMarcacion) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  const result = await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);

  assert.deepEqual(writes.inserted, [], "la fila manual es intocable");
  assert.deepEqual(writes.superseded, []);
  assert.equal(result.statusesWritten, 0);
});

test("processAttendanceDay: tampoco pisa un código que vino de Workera", async () => {
  const { client, writes } = supabaseStub(
    [],
    [],
    [{ id: "asr-1", employee_id: "emp-1", attendance_status_id: "status-V", source: "workera", source_version: 1 }]
  );
  const deps = scriptedDeps({ "emp-1": { attendance: derived() } });

  await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.deepEqual(writes.inserted, []);
});

test("processAttendanceDay: reprocesar sin cambios no versiona el código diario", async () => {
  const { client, writes } = supabaseStub(
    [],
    [],
    [{ id: "asr-1", employee_id: "emp-1", attendance_status_id: "status-P", source: "system", source_version: 1 }]
  );
  const deps = scriptedDeps({ "emp-1": { attendance: derived() } });

  const result = await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);

  assert.deepEqual(writes.inserted, [], "ya decía P: no hay nada que actualizar");
  assert.equal(result.statusesWritten, 0);
});

test("processAttendanceDay: sí actualiza su propia marca cuando el código cambia (ej. tras corregir la marcación)", async () => {
  const { client, writes } = supabaseStub(
    [],
    [],
    [{ id: "asr-1", employee_id: "emp-1", attendance_status_id: "status-?", source: "system", source_version: 1 }]
  );
  const deps = scriptedDeps({ "emp-1": { attendance: derived() } });

  await processAttendanceDay(client, DATE, { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);

  assert.deepEqual(writes.superseded, ["asr-1"], "la versión anterior se cierra");
  assert.equal(writes.inserted[0].attendance_status_id, "status-P");
});

// ---------------------------------------------------------------------------
// MB-6: feriados legales en el motor

test("processAttendanceDay: en un feriado le pasa isHoliday=true a deriveDailyAttendanceRecord", async () => {
  let received: boolean | undefined;
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived() } }),
    deriveDailyAttendanceRecord: (async (_s: unknown, _e: string, _d: string, isHoliday?: boolean) => {
      received = isHoliday;
      return derived();
    }) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  // El stub declara 2026-09-18 como feriado.
  const { client } = supabaseStub([], [], [], ["2026-09-18"]);
  await processAttendanceDay(client, "2026-09-18", { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.equal(received, true);
});

test("processAttendanceDay: un día normal pasa isHoliday=false", async () => {
  let received: boolean | undefined;
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived() } }),
    deriveDailyAttendanceRecord: (async (_s: unknown, _e: string, _d: string, isHoliday?: boolean) => {
      received = isHoliday;
      return derived();
    }) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  const { client } = supabaseStub([], [], [], ["2026-09-18"]);
  await processAttendanceDay(client, "2026-09-22", { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.equal(received, false);
});

test("processAttendanceDay: feriado sin marcación -> HOLIDAY, sin código diario ni candidatos", async () => {
  const { client, writes } = supabaseStub([], [], [], ["2026-09-18"]);
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({}),
    deriveDailyAttendanceRecord: (async () => noRecord("HOLIDAY")) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  const result = await processAttendanceDay(client, "2026-09-18", { companyId: COMPANY_ID, employeeIds: ["emp-1", "emp-2"] }, deps);

  assert.equal(result.holiday, 2);
  assert.deepEqual(writes.inserted, [], "un feriado sin marcación no genera '?' ni P");
  assert.equal(result.lateCandidates, 0);
});

test("processAttendanceDay: feriado trabajado genera solo HH100, nunca atraso ni salida anticipada", async () => {
  const { client } = supabaseStub([], [], [], ["2026-09-18"]);
  let lateCalls = 0;
  let earlyCalls = 0;
  let retiredLateCalls = 0;
  let retiredEarlyCalls = 0;
  let overtimeCalls = 0;
  let overtimeReceivedHoliday = false;
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({ "emp-1": { attendance: derived() } }),
    generateLateArrivalCandidate: (async () => {
      lateCalls += 1;
      return lateResult("GENERATED");
    }) as ProcessAttendanceDayDeps["generateLateArrivalCandidate"],
    generateEarlyDepartureCandidate: (async () => {
      earlyCalls += 1;
      return earlyResult("GENERATED");
    }) as ProcessAttendanceDayDeps["generateEarlyDepartureCandidate"],
    retireCurrentLateArrivalCandidate: (async () => {
      retiredLateCalls += 1;
      return true;
    }) as ProcessAttendanceDayDeps["retireCurrentLateArrivalCandidate"],
    retireCurrentEarlyDepartureCandidate: (async () => {
      retiredEarlyCalls += 1;
      return true;
    }) as ProcessAttendanceDayDeps["retireCurrentEarlyDepartureCandidate"],
    generateOvertimeCandidate: (async (
      _s: unknown,
      _employeeId: string,
      _date: string,
      _attendanceRecordId: string,
      _clockOut: string | null,
      _clockIn: string | null,
      isHoliday: boolean
    ) => {
      overtimeCalls += 1;
      overtimeReceivedHoliday = isHoliday;
      return overtimeResult("GENERATED");
    }) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };

  const result = await processAttendanceDay(client, "2026-09-18", { companyId: COMPANY_ID, employeeIds: ["emp-1"] }, deps);
  assert.equal(lateCalls, 0);
  assert.equal(earlyCalls, 0);
  assert.equal(retiredLateCalls, 1, "un feriado retira el atraso que pudiera haber quedado vigente");
  assert.equal(retiredEarlyCalls, 1, "un feriado retira la salida anticipada que pudiera haber quedado vigente");
  assert.equal(overtimeCalls, 1);
  assert.equal(overtimeReceivedHoliday, true);
  assert.equal(result.lateCandidates, 0);
  assert.equal(result.earlyDepartureCandidates, 0);
  assert.equal(result.overtimeCandidates, 1, "si marcó en el feriado, las horas extra HH100 sí se proponen");
  assert.equal(result.outcomes[0].lateArrival, null);
  assert.equal(result.outcomes[0].earlyDeparture, null);
});

// ---------------------------------------------------------------------------
// Aislamiento multiempresa bajo service_role

test("processAttendanceDay: valida employeeIds contra company_id y descarta IDs de otro tenant", async () => {
  const { client, employeeFilters } = supabaseStub(
    [],
    [],
    [],
    [],
    null,
    [
      { id: "emp-owned", company_id: COMPANY_ID, active: true },
      { id: "emp-foreign", company_id: OTHER_COMPANY_ID, active: true },
    ]
  );
  const deps = scriptedDeps({
    "emp-owned": { attendance: noRecord("EXEMPT") },
    "emp-foreign": { attendance: noRecord("EXEMPT") },
  });

  const result = await processAttendanceDay(
    client,
    DATE,
    scoped({ employeeIds: ["emp-owned", "emp-foreign"] }),
    deps
  );

  assert.deepEqual(result.outcomes.map((outcome) => outcome.employeeId), ["emp-owned"]);
  assert.ok(
    employeeFilters.some(
      (filter) => filter.method === "eq" && filter.column === "company_id" && filter.value === COMPANY_ID
    ),
    "la consulta service_role debe filtrar employees por el tenant explícito"
  );
});

test("processAttendanceDay: rechaza companyId vacío antes de consultar datos", async () => {
  const { client, employeeFilters } = supabaseStub();

  await assert.rejects(
    () => processAttendanceDay(client, DATE, { companyId: "   ", employeeIds: ["emp-1"] }, scriptedDeps({})),
    /companyId es obligatorio/
  );
  assert.deepEqual(employeeFilters, []);
});

test("processAttendanceDay: un reproceso explícito incluye a una persona hoy inactiva", async () => {
  const { client } = supabaseStub([], [], [], [], null, [
    { id: "emp-inactive", company_id: COMPANY_ID, active: false, hire_date: "2024-01-01" },
  ]);
  const result = await processAttendanceDay(
    client,
    DATE,
    { companyId: COMPANY_ID, employeeIds: ["emp-inactive"] },
    scriptedDeps({ "emp-inactive": { attendance: derived() } })
  );

  assert.equal(result.employeesProcessed, 1, "una corrección histórica no depende del estado activo actual");
});

test("processAttendanceDay: nunca deriva una fecha anterior al ingreso", async () => {
  const { client } = supabaseStub([], [], [], [], null, [
    { id: "emp-future", company_id: COMPANY_ID, active: true, hire_date: "2026-09-02" },
  ]);
  const result = await processAttendanceDay(
    client,
    DATE,
    { companyId: COMPANY_ID, employeeIds: ["emp-future"] },
    scriptedDeps({ "emp-future": { attendance: derived() } })
  );

  assert.equal(result.employeesProcessed, 0);
});

test("processAttendanceDay: pagina más de 1.000 empleados sin truncar el tenant", async () => {
  const employees = Array.from({ length: 1_001 }, (_, index) => ({
    id: `employee-${String(index).padStart(4, "0")}`,
    company_id: COMPANY_ID,
    active: true,
    employee_groups: { code: "PRODUCTION" },
  }));
  const { client } = supabaseStub([], [], [], [], null, employees);
  const deps: ProcessAttendanceDayDeps = {
    deriveDailyAttendanceRecord: (async (_s: unknown, employeeId: string) =>
      derived(`attendance-${employeeId}`)) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
    generateLateArrivalCandidate: (async () => lateResult("NO_LATE")) as ProcessAttendanceDayDeps["generateLateArrivalCandidate"],
    generateEarlyDepartureCandidate: (async () =>
      earlyResult("NO_EARLY_DEPARTURE")) as ProcessAttendanceDayDeps["generateEarlyDepartureCandidate"],
    retireCurrentLateArrivalCandidate: (async () => false) as ProcessAttendanceDayDeps["retireCurrentLateArrivalCandidate"],
    retireCurrentEarlyDepartureCandidate: (async () => false) as ProcessAttendanceDayDeps["retireCurrentEarlyDepartureCandidate"],
    generateOvertimeCandidate: (async () =>
      overtimeResult("NO_OVERTIME")) as ProcessAttendanceDayDeps["generateOvertimeCandidate"],
  };

  const result = await processAttendanceDay(client, DATE, { companyId: COMPANY_ID }, deps);

  assert.equal(result.employeesProcessed, 1_001);
  assert.equal(result.failures.length, 0);
});

test("processAttendanceDay: falla cerrado si no puede comprobar cumpleaños", async () => {
  const { client } = supabaseStub([], [], [], [], null, null, { message: "birthday service unavailable" });

  await assert.rejects(
    processAttendanceDay(
      client,
      DATE,
      { companyId: COMPANY_ID, employeeIds: ["emp-1"] },
      scriptedDeps({ "emp-1": { attendance: derived() } })
    ),
    /loadBirthdays: fallo leyendo employee_birthdays/
  );
});

function ruleEngineRunStub(options: { updateMatches?: boolean } = {}) {
  const base = supabaseStub().client as unknown as { from(table: string): unknown };
  const insertedRuns: Record<string, unknown>[] = [];
  const updateFilters: Array<Array<{ column: string; value: unknown }>> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: 0, error: null };
    },
    from(table: string) {
      if (table !== "rule_engine_runs") return base.from(table);
      return {
        insert(row: Record<string, unknown>) {
          insertedRuns.push(row);
          const insertChain = {
            select() {
              return insertChain;
            },
            single: async () => ({ data: { id: "run-1" }, error: null }),
          };
          return insertChain;
        },
        update() {
          const filters: Array<{ column: string; value: unknown }> = [];
          updateFilters.push(filters);
          const updateChain = {
            eq(column: string, value: unknown) {
              filters.push({ column, value });
              return updateChain;
            },
            select() {
              return updateChain;
            },
            maybeSingle: async () => ({
              data: options.updateMatches === false ? null : { id: "run-1" },
              error: null,
            }),
          };
          return updateChain;
        },
      };
    },
  };

  return { client, insertedRuns, updateFilters, rpcCalls };
}

test("runRuleEngineForDate: persiste y cierra la corrida con el company_id explícito", async () => {
  const { client, insertedRuns, updateFilters, rpcCalls } = ruleEngineRunStub();

  const outcome = await runRuleEngineForDate(client as never, DATE, {
    companyId: COMPANY_ID,
    triggeredBy: "CRON",
    options: { employeeIds: [] },
    deps: scriptedDeps({}),
  });

  assert.equal(outcome.status, "SUCCEEDED");
  assert.deepEqual(rpcCalls[0], {
    name: "reclaim_stale_rule_engine_runs",
    args: { p_company_id: COMPANY_ID, p_stale_after_seconds: 900 },
  });
  assert.equal(insertedRuns[0].company_id, COMPANY_ID);
  assert.ok(
    updateFilters[0].some((filter) => filter.column === "company_id" && filter.value === COMPANY_ID),
    "el cierre de la corrida también debe permanecer acotado al tenant"
  );
  assert.ok(
    updateFilters[0].some((filter) => filter.column === "status" && filter.value === "RUNNING"),
    "el cierre debe ser compare-and-set para no pisar una corrida ya recuperada"
  );
});

test("runRuleEngineForDate: no sobrescribe una corrida cuyo lease fue recuperado", async () => {
  const { client, updateFilters } = ruleEngineRunStub({ updateMatches: false });

  await assert.rejects(
    runRuleEngineForDate(client as never, DATE, {
      companyId: COMPANY_ID,
      triggeredBy: "CRON",
      options: { employeeIds: [] },
      deps: scriptedDeps({}),
    }),
    /perdió su lease/
  );

  assert.equal(updateFilters.length, 2, "intenta cerrar SUCCEEDED y luego registrar FAILED sin pisar otro estado");
  assert.ok(
    updateFilters.every((filters) => filters.some((filter) => filter.column === "status" && filter.value === "RUNNING"))
  );
});
