import { test } from "node:test";
import assert from "node:assert/strict";
import { processAttendanceDay, type ProcessAttendanceDayDeps } from "./process-attendance-day";
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

/**
 * Cubre `loadBirthdays`, `loadEffectivePunches` y `applyDailyStatus`; el resto
 * se inyecta por `deps`. Devuelve también un registro de las escrituras para
 * poder afirmar sobre ellas.
 */
function supabaseStub(
  birthdays: { employee_id: string; birth_month: number; birth_day: number }[] = [],
  effectivePunches: EffectivePunchRow[] = [],
  existingStatuses: StatusRecordRow[] = [],
  holidayDates: string[] = []
): { client: never; writes: StatusWrites } {
  const writes: StatusWrites = { inserted: [], superseded: [] };

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
    return [];
  };

  const client = {
    from: (table: string) => {
      // Builder encadenable y "thenable": cualquier combinación de
      // select/eq/gte/lte/in/order resuelve a los datos de esa tabla.
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "lte", "in", "order"]) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: dataFor(table), error: null });
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

  return { client, writes };
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

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1", "emp-2", "emp-3"] }, deps);

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

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["exento", "libre", "sin-horario"] }, deps);

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

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1", "emp-2", "emp-3"] }, deps);
  assert.equal(result.withoutSchedule, 2);
});

test("processAttendanceDay: el fallo de un trabajador no cancela a los demás", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: derived(), late: "GENERATED" },
    "emp-roto": { attendance: derived(), throwOn: "derive" },
    "emp-3": { attendance: derived(), overtime: "GENERATED" },
  });

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1", "emp-roto", "emp-3"] }, deps);

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

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-roto"] }, deps);

  assert.equal(result.attendanceDerived, 0);
  assert.equal(result.withoutSchedule, 0);
  assert.equal(result.failures.length, 1);
});

test("processAttendanceDay: un fallo dentro de un generador también queda aislado", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: derived() },
    "emp-roto": { attendance: derived(), throwOn: "late" },
  });

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1", "emp-roto"] }, deps);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /falla atraso/);
});

test("processAttendanceDay: UNCHANGED se cuenta aparte de DERIVED (reprocesar no infla las métricas)", async () => {
  const deps = scriptedDeps({
    "emp-1": { attendance: { status: "UNCHANGED", attendanceRecordId: "ar-1", clockIn: null, clockOut: null } },
    "emp-2": { attendance: derived() },
  });

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1", "emp-2"] }, deps);

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

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1"] }, deps);
  assert.equal(result.lateCandidates, 1);
});

test("processAttendanceDay: INSTALACIÓN sin política confirmada se reporta aparte, no como candidato generado", async () => {
  const deps = scriptedDeps({
    "instalacion-1": { attendance: derived(), overtime: "OVERTIME_POLICY_REQUIRES_CONFIRMATION" },
    "produccion-1": { attendance: derived(), overtime: "GENERATED" },
  });

  const result = await processAttendanceDay(stub(), DATE, { employeeIds: ["instalacion-1", "produccion-1"] }, deps);

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
    { employeeIds: ["emp-1"] },
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

  await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1"] }, deps);
  assert.equal(received, null);
});

test("processAttendanceDay: lista vacía es una corrida válida, no un error", async () => {
  const result = await processAttendanceDay(stub(), DATE, { employeeIds: [] }, scriptedDeps({}));
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
    { employeeIds: ["emp-1"] },
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

  await processAttendanceDay(stub(), DATE, { employeeIds: ["emp-1"] }, deps);
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
    { employeeIds: ["emp-1"] },
    deps
  );

  assert.equal(recibido[0], "2026-09-01T21:00:00Z", "debe seguir usando su propia marcación cruda");
});

// ---------------------------------------------------------------------------
// MB-4: código diario de asistencia

test("processAttendanceDay: marca P cuando hubo marcación de entrada", async () => {
  const { client, writes } = supabaseStub();
  const deps = scriptedDeps({ "emp-1": { attendance: derived() } });

  const result = await processAttendanceDay(client, DATE, { employeeIds: ["emp-1"] }, deps);

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

  await processAttendanceDay(client, DATE, { employeeIds: ["emp-1"] }, deps);

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

  const result = await processAttendanceDay(client, DATE, { employeeIds: ["exento", "libre", "sin-horario"] }, deps);

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

  const result = await processAttendanceDay(client, DATE, { employeeIds: ["emp-1"] }, deps);

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

  await processAttendanceDay(client, DATE, { employeeIds: ["emp-1"] }, deps);
  assert.deepEqual(writes.inserted, []);
});

test("processAttendanceDay: reprocesar sin cambios no versiona el código diario", async () => {
  const { client, writes } = supabaseStub(
    [],
    [],
    [{ id: "asr-1", employee_id: "emp-1", attendance_status_id: "status-P", source: "system", source_version: 1 }]
  );
  const deps = scriptedDeps({ "emp-1": { attendance: derived() } });

  const result = await processAttendanceDay(client, DATE, { employeeIds: ["emp-1"] }, deps);

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

  await processAttendanceDay(client, DATE, { employeeIds: ["emp-1"] }, deps);

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
  await processAttendanceDay(client, "2026-09-18", { employeeIds: ["emp-1"] }, deps);
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
  await processAttendanceDay(client, "2026-09-22", { employeeIds: ["emp-1"] }, deps);
  assert.equal(received, false);
});

test("processAttendanceDay: feriado sin marcación -> HOLIDAY, sin código diario ni candidatos", async () => {
  const { client, writes } = supabaseStub([], [], [], ["2026-09-18"]);
  const deps: ProcessAttendanceDayDeps = {
    ...scriptedDeps({}),
    deriveDailyAttendanceRecord: (async () => noRecord("HOLIDAY")) as ProcessAttendanceDayDeps["deriveDailyAttendanceRecord"],
  };

  const result = await processAttendanceDay(client, "2026-09-18", { employeeIds: ["emp-1", "emp-2"] }, deps);

  assert.equal(result.holiday, 2);
  assert.deepEqual(writes.inserted, [], "un feriado sin marcación no genera '?' ni P");
  assert.equal(result.lateCandidates, 0);
});

test("processAttendanceDay: feriado TRABAJADO (deriveDailyAttendanceRecord devuelve DERIVED) sí genera candidatos", async () => {
  const { client } = supabaseStub([], [], [], ["2026-09-18"]);
  const deps = scriptedDeps({ "emp-1": { attendance: derived(), overtime: "GENERATED" } });

  const result = await processAttendanceDay(client, "2026-09-18", { employeeIds: ["emp-1"] }, deps);
  assert.equal(result.overtimeCandidates, 1, "si marcó en el feriado, las horas extra (HH100) igual se proponen");
});
