import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  applyTemplateWorkerScope,
  buildAttendanceExportData,
  buildAttendanceExportWorkbook,
  calendarDaysBetween,
  isWeekend,
  type AttendanceExportWorker,
  type TemplateWorker,
} from "./attendance-export";
import type { AttendanceExportPeriod } from "./attendance-export-periods";

/**
 * El exportador replica la planilla REAL de ARCOTEX: matriz de un día por
 * columna y un bloque de 7 filas por trabajador. Nunca inventa un estado -- un
 * día sin fila vigente en `attendance_status_records` sale "?" (el código ya
 * definido para "tarjeta no marcada"), nunca P/F asumido. El alcance por área
 * reutiliza `areasVisibleToRole`, igual que el resto de la app.
 */

interface MockOpts {
  employees: { id: string; display_name: string; group: string }[];
  statuses?: { employee_id: string; work_date: string; code: string }[];
  lates?: { employee_id: string; work_date: string; detected_minutes: number; payroll_minutes?: number }[];
  overtimes?: { employee_id: string; work_date: string; code: string; approved_minutes: number | null }[];
  holidays?: string[];
}

function mockSupabase(opts: MockOpts) {
  const rowsFor = (table: string) => {
    if (table === "attendance_status_records") {
      return (opts.statuses ?? []).map((r) => ({
        employee_id: r.employee_id,
        work_date: r.work_date,
        attendance_statuses: { code: r.code },
      }));
    }
    if (table === "late_arrival_records") {
      return (opts.lates ?? []).map((r) => ({
        employee_id: r.employee_id,
        work_date: r.work_date,
        detected_minutes: r.detected_minutes,
        late_arrival_decisions:
          r.payroll_minutes === undefined ? [] : [{ payroll_minutes: r.payroll_minutes, is_current: true }],
      }));
    }
    if (table === "overtime_records") {
      return (opts.overtimes ?? []).map((r) => ({
        employee_id: r.employee_id,
        work_date: r.work_date,
        overtime_types: { code: r.code },
        overtime_decisions:
          r.approved_minutes === null
            ? []
            : [{ approved_minutes: r.approved_minutes, decision_status: "APPROVED", is_current: true }],
      }));
    }
    if (table === "holidays") {
      return (opts.holidays ?? []).map((d) => ({ holiday_date: d }));
    }
    throw new Error(`mockSupabase: tabla no soportada: ${table}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === "employees") {
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, areas: string[]) => ({
                order: () =>
                  Promise.resolve({
                    data: opts.employees
                      .filter((e) => areas.includes(e.group))
                      .map((e) => ({ id: e.id, display_name: e.display_name, employee_groups: { code: e.group } })),
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      // Builder encadenable: select/in/gte/lte/eq en cualquier orden, "thenable".
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "in", "gte", "lte", "eq"]) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: rowsFor(table), error: null });
      return builder;
    },
  };
  return client;
}

// 2026-08-17 lunes .. 2026-08-21 viernes (+ fin de semana 22-23)
const PERIOD: AttendanceExportPeriod = {
  type: "SEMANAL",
  startDate: "2026-08-17",
  endDate: "2026-08-23",
  label: "Semana de prueba",
};

const ONE_WORKER = [{ id: "emp-1", display_name: "TRABAJADOR UNO", group: "PRODUCTION" }];

// ---------------------------------------------------------------------------
// Helpers de calendario

test("calendarDaysBetween: incluye fines de semana (la planilla real los muestra como columnas en blanco)", () => {
  assert.deepEqual(calendarDaysBetween("2026-08-21", "2026-08-24"), ["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"]);
});

test("isWeekend: sábado y domingo", () => {
  assert.equal(isWeekend("2026-08-22"), true);
  assert.equal(isWeekend("2026-08-23"), true);
  assert.equal(isWeekend("2026-08-21"), false);
});

// ---------------------------------------------------------------------------
// Datos

test("buildAttendanceExportData: un día sin attendance_status_records -> '?', nunca P/F inventado", async () => {
  const data = await buildAttendanceExportData(mockSupabase({ employees: ONE_WORKER }), "SUPERVISOR_PRODUCTION", PERIOD);
  const worker = data.workers[0];
  for (const day of data.days.filter((d) => !isWeekend(d))) {
    assert.equal(worker.days.get(day)?.statusCode ?? "?", "?");
  }
});

test("buildAttendanceExportData: usa el código real cuando existe", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({ employees: ONE_WORKER, statuses: [{ employee_id: "emp-1", work_date: "2026-08-18", code: "L" }] }),
    "SUPERVISOR_PRODUCTION",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-18")?.statusCode, "L");
});

test("buildAttendanceExportData: un SUPERVISOR_PRODUCTION nunca ve empleados de otra área", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: [
        { id: "emp-prod", display_name: "PROD UNO", group: "PRODUCTION" },
        { id: "emp-inst", display_name: "INST UNO", group: "INSTALLATION" },
      ],
    }),
    "SUPERVISOR_PRODUCTION",
    PERIOD
  );
  assert.deepEqual(data.workers.map((w) => w.workerName), ["PROD UNO"]);
});

test("buildAttendanceExportData: SUPER_ADMIN ve todas las áreas", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: [
        { id: "emp-prod", display_name: "PROD UNO", group: "PRODUCTION" },
        { id: "emp-inst", display_name: "INST UNO", group: "INSTALLATION" },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers.length, 2);
});

test("buildAttendanceExportData: atraso ya decidido usa los minutos que van a liquidación, no los detectados", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      // Detectados 15, pero justificado -> 0 a liquidación.
      lates: [{ employee_id: "emp-1", work_date: "2026-08-17", detected_minutes: 15, payroll_minutes: 0 }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-17")?.lateMinutes, 0);
});

test("buildAttendanceExportData: atraso sin decidir muestra los minutos detectados", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({ employees: ONE_WORKER, lates: [{ employee_id: "emp-1", work_date: "2026-08-17", detected_minutes: 15 }] }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-17")?.lateMinutes, 15);
});

test("buildAttendanceExportData: una hora extra sin aprobar NO suma (candidato no es hora pagable)", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      overtimes: [{ employee_id: "emp-1", work_date: "2026-08-17", code: "OVERTIME_50", approved_minutes: null }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-17")?.overtime50Minutes ?? 0, 0);
});

test("buildAttendanceExportData: separa HH 50% de HH 100% según el tipo", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      overtimes: [
        { employee_id: "emp-1", work_date: "2026-08-17", code: "OVERTIME_50", approved_minutes: 120 },
        { employee_id: "emp-1", work_date: "2026-08-18", code: "OVERTIME_100", approved_minutes: 60 },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-17")?.overtime50Minutes, 120);
  assert.equal(data.workers[0].days.get("2026-08-17")?.overtime100Minutes, 0);
  assert.equal(data.workers[0].days.get("2026-08-18")?.overtime100Minutes, 60);
});

// ---------------------------------------------------------------------------
// Libro

function readSheet(bytes: Uint8Array): (string | number | null)[][] {
  const wb = XLSX.read(bytes, { type: "array" });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
}

async function buildSheet(opts: MockOpts, role: "SUPER_ADMIN" = "SUPER_ADMIN") {
  const data = await buildAttendanceExportData(mockSupabase(opts), role, PERIOD);
  return readSheet(buildAttendanceExportWorkbook(data));
}

test("libro: la leyenda de códigos va arriba, igual que la planilla real", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER });
  assert.match(String(rows[0][0]), /PLANILLA DE ASISTENCIA/);
  assert.deepEqual(rows[1].slice(0, 2), ["P", "PRESENTE"]);
  assert.deepEqual(rows[11].slice(0, 2), ["?", "TARJETA NO MARCADA O CON PROBLEMAS"]);
});

test("libro: una columna por día calendario, con el número de día en la fila 13", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER });
  // 2026-08-17 al 23 = 7 días, desde la columna D (índice 3).
  assert.deepEqual(rows[13].slice(3, 10), [17, 18, 19, 20, 21, 22, 23]);
});

test("libro: bloque de 7 filas por trabajador, con el nombre solo en la primera", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER });
  const block = rows.slice(14, 21);
  assert.deepEqual(
    block.map((r) => r[1]),
    ["Asistencia", "Faltas", "Vacaciones", "Licencia", "Atrasos", "HH 50%", "HH 100%"]
  );
  assert.equal(block[0][0], "TRABAJADOR UNO");
  assert.equal(block[1][0], null, "el nombre va combinado, no repetido en cada fila");
});

test("libro: los fines de semana quedan en blanco, nunca en 0", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER });
  // Columnas 8 y 9 = sábado 22 y domingo 23.
  assert.equal(rows[14][8], null);
  assert.equal(rows[14][9], null);
});

test("libro: Faltas / Vacaciones / Licencia marcan 1 en su día y totalizan en la columna C", async () => {
  const rows = await buildSheet({
    employees: ONE_WORKER,
    statuses: [
      { employee_id: "emp-1", work_date: "2026-08-17", code: "F" },
      { employee_id: "emp-1", work_date: "2026-08-18", code: "V" },
      { employee_id: "emp-1", work_date: "2026-08-19", code: "L" },
      { employee_id: "emp-1", work_date: "2026-08-20", code: "L-M" },
    ],
  });

  assert.equal(rows[15][2], 1, "Faltas total");
  assert.equal(rows[15][3], 1, "falta el lunes");
  assert.equal(rows[16][2], 1, "Vacaciones total");
  assert.equal(rows[17][2], 2, "Licencia total cuenta L y L-M");
});

test("libro: Asistencia descuenta vacaciones y licencia de los días hábiles", async () => {
  const rows = await buildSheet({
    employees: ONE_WORKER,
    statuses: [
      { employee_id: "emp-1", work_date: "2026-08-18", code: "V" },
      { employee_id: "emp-1", work_date: "2026-08-19", code: "L" },
    ],
  });
  // 5 días hábiles - 1 vacaciones - 1 licencia = 3
  assert.equal(rows[14][2], 3);
});

test("libro: las duraciones se guardan como fracción de día con formato h:mm:ss", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: ONE_WORKER,
        overtimes: [{ employee_id: "emp-1", work_date: "2026-08-17", code: "OVERTIME_50", approved_minutes: 120 }],
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  // `cellNF` es necesario para que el formato numérico sobreviva la relectura.
  const wb = XLSX.read(bytes, { type: "array", cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  // Fila 20 (0-indexada) = HH 50%; columna D = lunes 17.
  const cell = sheet[XLSX.utils.encode_cell({ r: 19, c: 3 })];
  assert.equal(cell.v, 120 / 1440, "2 horas = 1/12 de día");
  assert.equal(cell.z, "[h]:mm:ss");
});

test("libro: sin trabajadores sigue generando un archivo válido con la cabecera", async () => {
  const rows = await buildSheet({ employees: [] });
  assert.match(String(rows[0][0]), /PLANILLA DE ASISTENCIA/);
  assert.equal(rows.length, 14, "solo cabecera: título + leyenda + meses + días");
});

// --- MB-6: feriados en el export ---

test("buildAttendanceExportData: expone los feriados del período", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({ employees: ONE_WORKER, holidays: ["2026-08-19"] }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.ok(data.holidays.has("2026-08-19"));
});

test("libro: la columna de un feriado va en blanco, igual que un fin de semana", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER, holidays: ["2026-08-19"] });
  // 2026-08-17 es lunes -> día 17 en la columna D (índice 3). El 19 (miércoles
  // feriado) está en la columna F (índice 5).
  assert.equal(rows[13][5], 19, "la cabecera de día sí muestra el 19");
  assert.equal(rows[14][5], null, "pero la fila Asistencia lo deja en blanco");
});

test("libro: Asistencia no cuenta el feriado como día trabajado", async () => {
  // Período de prueba: L-V = 5 días hábiles. Con el miércoles 19 feriado -> 4.
  const conFeriado = await buildSheet({ employees: ONE_WORKER, holidays: ["2026-08-19"] });
  const sinFeriado = await buildSheet({ employees: ONE_WORKER });
  assert.equal(sinFeriado[14][2], 5);
  assert.equal(conFeriado[14][2], 4);
});

// ---------------------------------------------------------------------------
// Alcance de la plantilla de referencia (mockup de RRHH)
// ---------------------------------------------------------------------------

/**
 * La plantilla solo aporta ORDEN y ETIQUETA de las filas. El padrón lo define
 * siempre la consulta a `employees`: si el mockup pudiera recortarlo, una
 * contratación posterior desaparecería en silencio de un documento que
 * alimenta remuneraciones.
 */
function worker(id: string, workerName: string): AttendanceExportWorker {
  return { employeeId: id, workerName, area: "PRODUCTION", days: new Map() };
}

function templateEntry(label: string, tokens: string[]): TemplateWorker {
  return { label, tokens: new Set(tokens) };
}

test("plantilla: un trabajador vigente ausente del mockup NO se pierde del export", () => {
  const workers = [worker("e1", "JUAN PEREZ"), worker("e2", "MARIA SOTO")];
  const template = [templateEntry("JUAN PEREZ\nLUNES A VIERNES", ["JUAN", "PEREZ"])];

  const scoped = applyTemplateWorkerScope(workers, template, false);

  assert.deepEqual(
    scoped.map((w) => w.employeeId).sort(),
    ["e1", "e2"],
    "MARIA SOTO no está en el mockup, pero sigue siendo personal vigente"
  );
});

test("plantilla: el trabajador que sí coincide conserva el orden y la etiqueta del mockup", () => {
  const workers = [worker("e2", "MARIA SOTO"), worker("e1", "JUAN PEREZ")];
  const template = [templateEntry("JUAN PEREZ\nLUNES A VIERNES", ["JUAN", "PEREZ"])];

  const scoped = applyTemplateWorkerScope(workers, template, false);

  assert.equal(scoped[0].employeeId, "e1", "el orden del mockup manda para quien sí figura");
  assert.equal(scoped[0].workerName, "JUAN PEREZ\nLUNES A VIERNES", "conserva la etiqueta con horario");
  assert.equal(scoped[1].workerName, "MARIA SOTO", "el no listado conserva su nombre real");
});

test("plantilla: sin plantilla disponible el padrón queda intacto", () => {
  const workers = [worker("e1", "JUAN PEREZ"), worker("e2", "MARIA SOTO")];
  assert.deepEqual(applyTemplateWorkerScope(workers, null, true), workers);
});

test("plantilla: una misma fila del mockup nunca consume dos veces al mismo empleado", () => {
  const workers = [worker("e1", "JUAN PEREZ")];
  const template = [templateEntry("JUAN PEREZ", ["JUAN", "PEREZ"]), templateEntry("JUAN PEREZ", ["JUAN", "PEREZ"])];

  const scoped = applyTemplateWorkerScope(workers, template, false);

  assert.equal(scoped.length, 1, "la segunda fila no encuentra un empleado libre y no se duplica");
});
