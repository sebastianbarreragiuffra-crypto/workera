import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  buildAttendanceExportData as buildAttendanceExportDataForCompany,
  buildAttendanceExportWorkbook,
  calendarDaysBetween,
  isWeekend,
} from "./attendance-export";
import type { AttendanceExportPeriod } from "./attendance-export-periods";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../tenant/legacy-workforce";

function buildAttendanceExportData(
  supabase: Parameters<typeof buildAttendanceExportDataForCompany>[0],
  callerRole: Parameters<typeof buildAttendanceExportDataForCompany>[1],
  period: Parameters<typeof buildAttendanceExportDataForCompany>[2]
) {
  return buildAttendanceExportDataForCompany(supabase, callerRole, period, ARCOTEX_WORKFORCE_COMPANY_ID);
}

/**
 * El exportador replica la planilla REAL de ARCOTEX: matriz de un día por
 * columna y un bloque de 10 filas por trabajador. Nunca inventa un estado -- un
 * día sin fila vigente en `attendance_status_records` sale "?" (el código ya
 * definido para "tarjeta no marcada"), nunca P/F asumido. El alcance por área
 * reutiliza `areasVisibleToRole`, igual que el resto de la app.
 */

interface MockOpts {
  employees: {
    id: string;
    display_name: string;
    group: string;
    hire_date?: string | null;
    active?: boolean;
    company_id?: string;
    external_workera_id?: string;
    rut?: string | null;
  }[];
  statuses?: { employee_id: string; work_date: string; code: string }[];
  lates?: {
    employee_id: string;
    work_date: string;
    detected_minutes: number;
    payroll_minutes?: number;
    payroll_effect?: "DEDUCT" | "DO_NOT_DEDUCT" | "NEEDS_REVIEW";
  }[];
  earlyDepartures?: {
    employee_id: string;
    work_date: string;
    detected_minutes: number;
    payroll_minutes?: number;
    payroll_effect?: "DEDUCT" | "DO_NOT_DEDUCT" | "NEEDS_REVIEW";
  }[];
  overtimes?: {
    employee_id: string;
    work_date: string;
    code: string;
    approved_minutes: number | null;
    candidate_minutes?: number;
    bonus_amount?: number;
    bonus_currency?: string;
  }[];
  missingPunches?: {
    employee_id: string;
    work_date: string;
    status: "PENDING_CONTACT" | "CONTACTED";
    attendanceCurrent?: boolean;
  }[];
  absences?: {
    employee_id: string;
    start_date: string;
    end_date: string;
    decision_status?: "CONFIRMED" | "CORRECTED" | "PENDING_DOCUMENT" | "DISPUTED";
  }[];
  ruleEngineRuns?: {
    work_date: string;
    status: "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
    started_at: string;
    company_id?: string;
  }[];
  ruleEngineRunsAfter?: MockOpts["ruleEngineRuns"];
  holidays?: string[];
  holidayError?: string;
  timeControlPolicyError?: string;
  reportingPeriodStatus?: "OPEN" | "IN_REVIEW" | "READY_TO_CLOSE" | "CLOSED" | "REOPENED" | null;
  schedules?: {
    employee_id: string;
    effective_from: string;
    effective_to: string | null;
    work_schedules: {
      work_schedule_rules: { day_of_week: number; scheduled_start: string; scheduled_end: string }[];
    };
  }[];
  timeControlPolicies?: {
    employee_id: string;
    effective_from: string;
    effective_to: string | null;
    policy_code: "NORMAL" | "EXEMPT_FROM_TIME_CONTROL";
  }[];
}

function mockSupabase(opts: MockOpts) {
  let ruleEngineReadCount = 0;
  const rowsFor = (table: string): Record<string, unknown>[] => {
    if (table === "employees") {
      return opts.employees.map((employee) => ({
        id: employee.id,
        external_workera_id: employee.external_workera_id ?? employee.id,
        rut: employee.rut ?? null,
        display_name: employee.display_name,
        hire_date: employee.hire_date ?? null,
        active: employee.active ?? true,
        company_id: employee.company_id ?? ARCOTEX_WORKFORCE_COMPANY_ID,
        employee_groups: { code: employee.group },
      }));
    }
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
          r.payroll_minutes === undefined
            ? []
            : [{ payroll_minutes: r.payroll_minutes, payroll_effect: r.payroll_effect ?? "DEDUCT", is_current: true }],
      }));
    }
    if (table === "early_departure_records") {
      return (opts.earlyDepartures ?? []).map((row) => ({
        employee_id: row.employee_id,
        work_date: row.work_date,
        detected_minutes: row.detected_minutes,
        early_departure_decisions:
          row.payroll_minutes === undefined
            ? []
            : [
                {
                  payroll_minutes: row.payroll_minutes,
                  payroll_effect: row.payroll_effect ?? "DEDUCT",
                  is_current: true,
                },
              ],
      }));
    }
    if (table === "overtime_records") {
      return (opts.overtimes ?? []).map((r) => ({
        employee_id: r.employee_id,
        work_date: r.work_date,
        candidate_minutes: r.candidate_minutes ?? r.approved_minutes ?? 60,
        overtime_types: { code: r.code },
        overtime_decisions:
          r.approved_minutes === null
            ? []
            : [{
                approved_minutes: r.approved_minutes,
                decision_status: "FULLY_APPROVED",
                is_current: true,
                employee_daily_bonuses:
                  r.bonus_amount === undefined
                    ? []
                    : [{ amount: r.bonus_amount, currency: r.bonus_currency ?? "CLP" }],
              }],
      }));
    }
    if (table === "holidays") {
      return (opts.holidays ?? []).map((d) => ({ holiday_date: d }));
    }
    if (table === "attendance_missing_punch_flags") {
      return (opts.missingPunches ?? []).map((row) => ({
        employee_id: row.employee_id,
        work_date: row.work_date,
        status: row.status,
        attendance_records: { is_current: row.attendanceCurrent ?? true },
      }));
    }
    if (table === "absence_records") {
      return (opts.absences ?? []).map((row) => ({
        employee_id: row.employee_id,
        start_date: row.start_date,
        end_date: row.end_date,
        absence_decisions:
          row.decision_status === undefined
            ? []
            : [{ decision_status: row.decision_status, is_current: true }],
      }));
    }
    if (table === "rule_engine_runs") {
      const configuredRuns =
        ruleEngineReadCount++ === 0 ? opts.ruleEngineRuns : (opts.ruleEngineRunsAfter ?? opts.ruleEngineRuns);
      if (configuredRuns?.length === 0) return [];
      const successfulCoverage = calendarDaysBetween("2026-07-16", "2026-08-23")
        .filter((workDate) => !isWeekend(workDate))
        .map((workDate) => ({
          work_date: workDate,
          status: "SUCCEEDED" as const,
          started_at: `${workDate}T12:00:00Z`,
          company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
        }));
      return [...successfulCoverage, ...(configuredRuns ?? [])].map((row) => ({
        ...row,
        company_id: row.company_id ?? ARCOTEX_WORKFORCE_COMPANY_ID,
      }));
    }
    // Sin horario asignado: la persona no lleva texto bajo el nombre ni
    // resaltado de días. Los casos que sí lo ejercitan lo pasan explícito.
    if (table === "schedule_assignments") return (opts.schedules ?? []) as Record<string, unknown>[];
    if (table === "employee_time_control_policies") {
      return (opts.timeControlPolicies ?? []) as Record<string, unknown>[];
    }
    if (table === "reporting_periods") {
      return opts.reportingPeriodStatus === undefined || opts.reportingPeriodStatus === null
        ? []
        : [{ status: opts.reportingPeriodStatus }];
    }
    throw new Error(`mockSupabase: tabla no soportada: ${table}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      const filters = new Map<string, unknown>();
      let page: { from: number; to: number } | null = null;
      const result = () => {
        if (table === "holidays" && opts.holidayError) {
          return { data: null, error: { message: opts.holidayError } };
        }
        if (table === "employee_time_control_policies" && opts.timeControlPolicyError) {
          return { data: null, error: { message: opts.timeControlPolicyError } };
        }

        let rows = rowsFor(table);
        const allowedAreas = filters.get("employee_groups.code") as string[] | undefined;
        const companyId = filters.get("company_id") as string | undefined;
        const employeeIds = filters.get("employee_id") as string[] | undefined;
        const allowedStatuses = filters.get("status") as string[] | undefined;
        if (table === "employees" && allowedAreas) {
          rows = rows.filter((row) => allowedAreas.includes((row.employee_groups as { code: string }).code));
        }
        if (table === "employees" && companyId) {
          rows = rows.filter((row) => row.company_id === companyId);
        }
        if (table === "rule_engine_runs" && companyId) {
          rows = rows.filter((row) => row.company_id === companyId);
        }
        if (employeeIds) {
          rows = rows.filter((row) => employeeIds.includes(String(row.employee_id)));
        }
        if (allowedStatuses) {
          rows = rows.filter((row) => allowedStatuses.includes(String(row.status)));
        }
        if (table === "attendance_missing_punch_flags" && filters.get("attendance_records.is_current") === true) {
          rows = rows.filter(
            (row) => (row.attendance_records as { is_current?: boolean } | undefined)?.is_current === true
          );
        }
        if (page) rows = rows.slice(page.from, page.to + 1);
        return { data: rows, error: null };
      };

      // Builder encadenable y thenable, incluidas las operaciones de
      // paginación/orden que usa el exportador real.
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters.set(column, value);
        return builder;
      };
      builder.in = (column: string, values: unknown[]) => {
        filters.set(column, values);
        return builder;
      };
      for (const method of ["gte", "lte"]) builder[method] = () => builder;
      builder.order = () => builder;
      builder.range = (from: number, to: number) => {
        page = { from, to };
        return builder;
      };
      builder.maybeSingle = async () => {
        const response = result();
        return { data: response.data?.[0] ?? null, error: response.error };
      };
      builder.then = (resolve: (value: unknown) => void) => resolve(result());
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

const PAYROLL_PERIOD: AttendanceExportPeriod = {
  type: "PAGO",
  startDate: "2026-07-16",
  endDate: "2026-08-15",
  label: "Remuneraciones agosto de 2026 · 16 de julio al 15 de agosto de 2026",
};

const ONE_WORKER = [{ id: "emp-1", display_name: "TRABAJADOR UNO", group: "PRODUCTION" }];
const MONDAY_FRIDAY_SCHEDULE = [
  {
    employee_id: "emp-1",
    effective_from: "2026-01-01",
    effective_to: null,
    work_schedules: {
      work_schedule_rules: [1, 2, 3, 4, 5].map((day_of_week) => ({
        day_of_week,
        scheduled_start: "07:30:00",
        scheduled_end: "17:00:00",
      })),
    },
  },
];

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

test("buildAttendanceExportData: solo RRHH y owner reciben identificadores de nómina", async () => {
  const employees = [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "EXCEL-11111111-1" }];
  const supervisor = await buildAttendanceExportData(mockSupabase({ employees }), "SUPERVISOR_PRODUCTION", PERIOD);
  const rrhh = await buildAttendanceExportData(mockSupabase({ employees }), "ADMIN_RRHH", PERIOD);

  assert.equal(supervisor.workers[0].employeeRut, null);
  assert.equal(supervisor.workers[0].employeeCode, "", "un ID bootstrap tampoco puede filtrar el RUT");
  assert.equal(rrhh.workers[0].employeeRut, "11111111-1");
  assert.equal(rrhh.workers[0].employeeCode, "EXCEL-11111111-1");
});

test("libro: la descarga de un supervisor no filtra RUT mediante un código bootstrap", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: [{
          ...ONE_WORKER[0],
          rut: "11111111-1",
          external_workera_id: "EXCEL-11111111-1",
        }],
      }),
      "SUPERVISOR_PRODUCTION",
      PERIOD
    )
  );
  const workbook = XLSX.read(bytes, { type: "array" });
  const visibleText = workbook.SheetNames
    .flatMap((name) => readSheet(bytes, name))
    .flat()
    .map(String)
    .join(" ");

  assert.doesNotMatch(visibleText, /11111111-1/);
  assert.doesNotMatch(visibleText, /EXCEL-11111111-1/);
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

test("buildAttendanceExportData: nunca mezcla trabajadores de otra empresa", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: [
        ...ONE_WORKER,
        { id: "foreign", display_name: "OTRA EMPRESA", group: "PRODUCTION", company_id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.deepEqual(data.workers.map((worker) => worker.workerName), ["TRABAJADOR UNO"]);
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

test("buildAttendanceExportData: atraso sin decidir conserva lo detectado pero suma cero a nómina", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({ employees: ONE_WORKER, lates: [{ employee_id: "emp-1", work_date: "2026-08-17", detected_minutes: 15 }] }),
    "SUPER_ADMIN",
    PERIOD
  );
  const day = data.workers[0].days.get("2026-08-17");
  assert.equal(day?.lateDetectedMinutes, 15);
  assert.equal(day?.lateMinutes, 0);
  assert.equal(day?.lateDecisionPending, true);
});

test("buildAttendanceExportData: un atraso NEEDS_REVIEW tampoco entra al descuento", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      lates: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        detected_minutes: 20,
        payroll_minutes: 20,
        payroll_effect: "NEEDS_REVIEW",
      }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const day = data.workers[0].days.get("2026-08-17");
  assert.equal(day?.lateDetectedMinutes, 20);
  assert.equal(day?.lateMinutes, 0);
  assert.equal(day?.lateDecisionPending, true);
});

test("buildAttendanceExportData: DO_NOT_DEDUCT fuerza cero y una decisión incoherente queda pendiente", async () => {
  const justified = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      lates: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        detected_minutes: 20,
        payroll_minutes: 0,
        payroll_effect: "DO_NOT_DEDUCT",
      }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(justified.workers[0].days.get("2026-08-17")?.lateMinutes, 0);
  assert.equal(justified.workers[0].days.get("2026-08-17")?.lateDecisionPending, false);

  const inconsistent = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      lates: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        detected_minutes: 20,
        payroll_minutes: 20,
        payroll_effect: "DO_NOT_DEDUCT",
      }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(inconsistent.workers[0].days.get("2026-08-17")?.lateMinutes, 0);
  assert.equal(inconsistent.workers[0].days.get("2026-08-17")?.lateDecisionPending, true);
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

test("buildAttendanceExportData: lee el bono diario automático desde la decisión vigente", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      overtimes: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        code: "OVERTIME_50",
        approved_minutes: 120,
        bonus_amount: 1_000,
      }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-17")?.bonusAmount, 1_000);
});

test("buildAttendanceExportData: rechaza un bono en moneda distinta de CLP", async () => {
  await assert.rejects(
    buildAttendanceExportData(
      mockSupabase({
        employees: ONE_WORKER,
        overtimes: [{
          employee_id: "emp-1",
          work_date: "2026-08-17",
          code: "OVERTIME_50",
          approved_minutes: 120,
          bonus_amount: 1_000,
          bonus_currency: "USD",
        }],
      }),
      "SUPER_ADMIN",
      PERIOD
    ),
    /moneda de bono no soportada/
  );
});

test("buildAttendanceExportData: pagina más de 1.000 estados sin truncarlos", async () => {
  const statuses = Array.from({ length: 1_001 }, (_, index) => ({
    employee_id: "emp-1",
    work_date: "2026-08-18",
    code: index === 1_000 ? "L" : "P",
  }));
  const data = await buildAttendanceExportData(
    mockSupabase({ employees: ONE_WORKER, statuses }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-18")?.statusCode, "L");
});

test("buildAttendanceExportData: falla cerrado si no puede cargar los feriados", async () => {
  await assert.rejects(
    buildAttendanceExportData(
      mockSupabase({ employees: ONE_WORKER, holidayError: "servicio no disponible" }),
      "SUPER_ADMIN",
      PERIOD
    ),
    /fallo leyendo holidays/
  );
});

test("buildAttendanceExportData: rechaza un tipo de hora extra desconocido", async () => {
  await assert.rejects(
    buildAttendanceExportData(
      mockSupabase({
        employees: ONE_WORKER,
        overtimes: [{ employee_id: "emp-1", work_date: "2026-08-17", code: "OVERTIME_FUTURE", approved_minutes: 60 }],
      }),
      "SUPER_ADMIN",
      PERIOD
    ),
    /tipo de hora extra no soportado/
  );
});

test("buildAttendanceExportData: conserva a una persona inactiva con hechos históricos", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: [{ ...ONE_WORKER[0], active: false }],
      statuses: [{ employee_id: "emp-1", work_date: "2026-08-18", code: "P" }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers.length, 1);
  assert.equal(data.workers[0].currentlyActive, false);
});

test("buildAttendanceExportData: respeta la vigencia exacta de una exención de marcación", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      timeControlPolicies: [
        {
          employee_id: "emp-1",
          effective_from: "2026-08-18",
          effective_to: "2026-08-20",
          policy_code: "EXEMPT_FROM_TIME_CONTROL",
        },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );

  assert.deepEqual([...data.workers[0].exemptDates], ["2026-08-18", "2026-08-19", "2026-08-20"]);
});

test("buildAttendanceExportData: falla cerrado si no puede comprobar las exenciones", async () => {
  await assert.rejects(
    buildAttendanceExportData(
      mockSupabase({ employees: ONE_WORKER, timeControlPolicyError: "permisos temporalmente no disponibles" }),
      "SUPER_ADMIN",
      PERIOD
    ),
    /fallo leyendo exenciones: permisos temporalmente no disponibles/
  );
});

// ---------------------------------------------------------------------------
// Libro

function readSheet(bytes: Uint8Array, sheetName?: string): (string | number | null)[][] {
  const wb = XLSX.read(bytes, { type: "array" });
  const selected = sheetName ?? wb.SheetNames.at(-1)!;
  return XLSX.utils.sheet_to_json(wb.Sheets[selected], { header: 1, defval: null });
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

test("libro: bloque de 10 filas por trabajador, con trazabilidad completa", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER });
  const block = rows.slice(14, 24);
  assert.deepEqual(
    block.map((r) => r[1]),
    ["Asistencia", "Faltas", "Vacaciones", "Licencia", "Atrasos", "Salida anticipada", "HH 50%", "HH 100%", "Bono HE", "VIATICOS"]
  );
  assert.match(String(block[0][0]), /^TRABAJADOR UNO/);
  assert.equal(block[1][0], "", "el nombre va combinado, no repetido en cada fila");
  assert.equal(block[9][2], "", "viáticos queda vacío hasta disponer de una fuente autorizada");
});

test("libro: un atraso pendiente queda en la cola y nunca en el total descontable", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((workDate) => !isWeekend(workDate))
    .map((workDate) => ({ employee_id: "emp-1", work_date: workDate, code: "P" }));
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: [{ ...ONE_WORKER[0], rut: "11111111-1" }],
        schedules: MONDAY_FRIDAY_SCHEDULE,
        statuses,
        lates: [{ employee_id: "emp-1", work_date: "2026-08-17", detected_minutes: 15 }],
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const summary = readSheet(bytes, "RESUMEN");
  const pending = readSheet(bytes, "PENDIENTES");
  const detail = readSheet(bytes);
  const pendingLate = pending.find((row) => row[6] === "Atraso por resolver");

  assert.equal(summary[5][10], 0, "no descuenta minutos todavía no autorizados");
  assert.equal(detail[18][2], 0, "el total diario tampoco los suma");
  assert.equal(detail[18][3], "PEND.", "la matriz hace visible que existe una incidencia");
  assert.equal(pendingLate?.[2], "11111111-1");
  assert.equal(pendingLate?.[7], 15, "la cola conserva los minutos detectados");
});

test("libro: muestra el bono HE automático en resumen y respaldo diario", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
        overtimes: [{
          employee_id: "emp-1",
          work_date: "2026-08-17",
          code: "OVERTIME_50",
          approved_minutes: 120,
          bonus_amount: 1_000,
        }],
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const summary = readSheet(bytes, "RESUMEN");
  const detail = readSheet(bytes);

  assert.deepEqual(summary[5].slice(0, 3), ["WK-001", "11111111-1", "TRABAJADOR UNO"]);
  assert.equal(summary[5][13], 120 / 1_440, "HH50 aprobadas");
  assert.equal(summary[5][15], 1, "un día con bono");
  assert.equal(summary[5][16], 1_000, "monto autoritativo de la política");
  assert.equal(summary[5][17], "17/08");
  assert.equal(detail[22][2], 1_000);
  assert.equal(detail[22][3], 1_000);
});

test("libro: días de bono son enteros y TOTAL EMPRESA conserva fórmulas auditables", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: ONE_WORKER,
        overtimes: [{
          employee_id: "emp-1",
          work_date: "2026-08-17",
          code: "OVERTIME_50",
          approved_minutes: 60,
          bonus_amount: 1_000,
        }],
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const workbook = XLSX.read(bytes, { type: "array", cellNF: true });
  const summary = workbook.Sheets.RESUMEN;

  assert.equal(summary.P6.z, "#,##0", "un día con bono no se presenta como 1,00");
  assert.equal(summary.C7.v, "TOTAL EMPRESA");
  assert.equal(summary.N7.f, "SUM(N6:N6)");
  assert.equal(summary.Q7.f, "SUM(Q6:Q6)");
  assert.equal(summary.Q7.v, 1_000);
});

test("libro: el código R bloquea la liquidación hasta definir su efecto", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((workDate) => !isWeekend(workDate))
    .map((workDate) => ({ employee_id: "emp-1", work_date: workDate, code: workDate === "2026-08-18" ? "R" : "P" }));
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({ employees: ONE_WORKER, schedules: MONDAY_FRIDAY_SCHEDULE, statuses }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const summary = readSheet(bytes, "RESUMEN");
  const pending = readSheet(bytes, "PENDIENTES");

  assert.equal(summary[5][18], "Revisar");
  assert.match(String(summary[5][20]), /Códigos sin efecto de nómina definido: 1/);
  assert.ok(pending.some((row) => String(row[6]).includes("Código diario R")));
});

test("libro: los fines de semana quedan en blanco, nunca en 0", async () => {
  const rows = await buildSheet({ employees: ONE_WORKER });
  // Columnas 8 y 9 = sábado 22 y domingo 23. Sin valor, pero la celda ahora
  // existe para llevar el amarillo del fin de semana que usa la planilla.
  assert.equal(rows[14][8], "");
  assert.equal(rows[14][9], "");
});

test("libro: el fin de semana va amarillo y el feriado magenta, como la planilla", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({ employees: ONE_WORKER, holidays: ["2026-08-19"] }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const wb = XLSX.read(bytes, { type: "array", cellStyles: true });
  const sheet = wb.Sheets[wb.SheetNames.at(-1)!];
  // Según con qué lector se relea, el relleno queda en `s.fill` o directamente
  // en `s`. Se aceptan las dos formas para no atar la prueba al lector.
  const fill = (r: number, c: number) => {
    const s = sheet[XLSX.utils.encode_cell({ r, c })]?.s as
      | { fill?: { fgColor?: { rgb?: string } }; fgColor?: { rgb?: string } }
      | undefined;
    return s?.fill?.fgColor?.rgb ?? s?.fgColor?.rgb;
  };

  assert.equal(fill(14, 8), "FFF2CC", "sábado 22");
  assert.equal(fill(14, 5), "E4DFEC", "miércoles 19, feriado");
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

test("libro: Asistencia descuenta faltas y licencia de los días hábiles", async () => {
  const rows = await buildSheet({
    employees: ONE_WORKER,
    statuses: [
      { employee_id: "emp-1", work_date: "2026-08-18", code: "F" },
      { employee_id: "emp-1", work_date: "2026-08-19", code: "L" },
    ],
  });
  // 5 días hábiles - 1 falta - 1 licencia = 3, igual que `=14-C16-C18` en el
  // libro de RRHH: ahí la vacación no descuenta de Asistencia.
  assert.equal(rows[14][2], 3);
});

test("libro: el valor de Asistencia coincide con su propia fórmula", async () => {
  // Antes no coincidían: el valor restaba vacaciones y la fórmula restaba
  // faltas, así que bastaba una falta para que Excel mostrara un número y
  // cualquier lector que no recalcule mostrara otro. Este caso los separa a
  // propósito: una falta y una vacación, que es donde las dos definiciones
  // divergen.
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: ONE_WORKER,
        statuses: [
          { employee_id: "emp-1", work_date: "2026-08-17", code: "F" },
          { employee_id: "emp-1", work_date: "2026-08-18", code: "V" },
        ],
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const wb = XLSX.read(bytes, { type: "array", cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames.at(-1)!];
  const asistencia = sheet[XLSX.utils.encode_cell({ r: 14, c: 2 })];

  assert.equal(asistencia.f, "MAX(0,5-C16-C18)", "hábiles menos Faltas menos Licencia, nunca negativo");
  assert.equal(asistencia.v, 4, "5 hábiles - 1 falta - 0 licencia");
});

test("libro: una licencia de calendario completa nunca recalcula Asistencia negativa", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate).map((work_date) => ({
    employee_id: "emp-1",
    work_date,
    code: "L",
  }));
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(mockSupabase({ employees: ONE_WORKER, statuses }), "SUPER_ADMIN", PERIOD)
  );
  const wb = XLSX.read(bytes, { type: "array", cellNF: true });
  const asistencia = wb.Sheets[wb.SheetNames.at(-1)!][XLSX.utils.encode_cell({ r: 14, c: 2 })];

  assert.equal(asistencia.f, "MAX(0,5-C16-C18)");
  assert.equal(asistencia.v, 0);
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
  const sheet = wb.Sheets[wb.SheetNames.at(-1)!];

  // Fila 21 (0-indexada 20) = HH 50%; columna D = lunes 17.
  const cell = sheet[XLSX.utils.encode_cell({ r: 20, c: 3 })];
  assert.equal(cell.v, 120 / 1440, "2 horas = 1/12 de día");
  assert.equal(cell.z, "h:mm:ss;@", "el formato del libro de RRHH, no [h]:mm:ss");
});

test("libro: el total de horas usa [h]:mm:ss y no vuelve a cero sobre 24 horas", async () => {
  const overtimes = PERIOD.startDate === "2026-08-17"
    ? calendarDaysBetween(PERIOD.startDate, PERIOD.endDate).map((work_date) => ({
        employee_id: "emp-1",
        work_date,
        code: "OVERTIME_50",
        approved_minutes: 300,
      }))
    : [];
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(mockSupabase({ employees: ONE_WORKER, overtimes }), "SUPER_ADMIN", PERIOD)
  );
  const wb = XLSX.read(bytes, { type: "array", cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames.at(-1)!];
  const total = sheet[XLSX.utils.encode_cell({ r: 20, c: 2 })];
  assert.equal(total.v, 2_100 / 1_440);
  assert.equal(total.z, "[h]:mm:ss");
});

test("libro: conserva HH50 de sábado, HH100 de feriado y licencias de fin de semana", async () => {
  const rows = await buildSheet({
    employees: ONE_WORKER,
    holidays: ["2026-08-19"],
    statuses: [
      { employee_id: "emp-1", work_date: "2026-08-19", code: "P" },
      { employee_id: "emp-1", work_date: "2026-08-22", code: "L-M" },
    ],
    overtimes: [
      { employee_id: "emp-1", work_date: "2026-08-19", code: "OVERTIME_100", approved_minutes: 180 },
      { employee_id: "emp-1", work_date: "2026-08-22", code: "OVERTIME_50", approved_minutes: 120 },
    ],
  });
  assert.equal(rows[17][8], 1, "la licencia mutual del sábado se cuenta");
  assert.equal(rows[20][8], 120 / 1_440, "las HH50 del sábado se conservan");
  assert.equal(rows[21][5], 180 / 1_440, "las HH100 del feriado se conservan");
});

test("libro: respeta fecha de ingreso y días libres del horario vigente", async () => {
  const rows = await buildSheet({
    employees: [{ ...ONE_WORKER[0], hire_date: "2026-08-19" }],
    statuses: [{ employee_id: "emp-1", work_date: "2026-08-19", code: "P" }],
    schedules: [
      {
        employee_id: "emp-1",
        effective_from: "2026-01-01",
        effective_to: null,
        work_schedules: {
          work_schedule_rules: [1, 3, 5].map((day_of_week) => ({
            day_of_week,
            scheduled_start: "08:00:00",
            scheduled_end: "17:00:00",
          })),
        },
      },
    ],
  });
  assert.equal(rows[14][2], 2, "miércoles y viernes son los dos días base posteriores al ingreso");
  assert.equal(rows[14][3], "", "el lunes anterior al ingreso queda en blanco");
  assert.equal(rows[14][4], "", "el martes libre queda en blanco");
  assert.equal(rows[14][5], "P", "el miércoles trabajado conserva su código");
  assert.equal(rows[14][6], "", "el jueves libre queda en blanco");
});

test("libro: un hecho anterior al ingreso se muestra para corregir, pero nunca afecta la nómina", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: [{ ...ONE_WORKER[0], hire_date: "2026-08-19" }],
        statuses: [
          { employee_id: "emp-1", work_date: "2026-08-17", code: "F" },
          { employee_id: "emp-1", work_date: "2026-08-19", code: "P" },
        ],
        lates: [{
          employee_id: "emp-1",
          work_date: "2026-08-17",
          detected_minutes: 15,
          payroll_minutes: 15,
          payroll_effect: "DEDUCT",
        }],
        overtimes: [{
          employee_id: "emp-1",
          work_date: "2026-08-17",
          code: "OVERTIME_50",
          approved_minutes: 60,
          bonus_amount: 1_000,
        }],
        schedules: MONDAY_FRIDAY_SCHEDULE,
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const summary = readSheet(bytes, "RESUMEN");
  const pending = readSheet(bytes, "PENDIENTES");
  const detail = readSheet(bytes);

  assert.deepEqual(summary[5].slice(4, 8), [3, 0, 0, 3], "la base comienza el día de ingreso y no descuenta la anomalía");
  assert.equal(summary[5][10], 0, "el atraso pre-ingreso no descuenta");
  assert.equal(summary[5][13], 0, "la HH50 pre-ingreso no paga");
  assert.equal(summary[5][16], 0, "el bono pre-ingreso no paga");
  assert.equal(summary[5][18], "Revisar");
  assert.ok(pending.some((row) => row[6] === "Hecho de asistencia anterior al ingreso"));
  assert.equal(detail[15][3], "PEND.");
  assert.equal(detail[18][3], "PEND.");
  assert.equal(detail[20][3], "PEND.");
  assert.equal(detail[22][3], "PEND.");
  assert.equal(detail[15][2], 0);
  assert.equal(detail[18][2], 0);
  assert.equal(detail[20][2], 0);
  assert.equal(detail[22][2], 0);
});

test("libro: una persona exenta conserva su base y no genera falsos pendientes", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      timeControlPolicies: [
        {
          employee_id: "emp-1",
          effective_from: PERIOD.startDate,
          effective_to: PERIOD.endDate,
          policy_code: "EXEMPT_FROM_TIME_CONTROL",
        },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const bytes = buildAttendanceExportWorkbook(data);
  const detail = readSheet(bytes);
  const summary = readSheet(bytes, "RESUMEN");

  assert.equal(detail[14][2], 5, "la exención de marcación no reduce la base pagada");
  assert.deepEqual(detail[14].slice(3, 10), ["", "", "", "", "", "", ""]);
  assert.equal(summary[5][21], "Exento de marcación");
  assert.equal(summary[5][18], "Sin pendientes");
  assert.match(String(summary[5][20]), /Exento de marcación/);
});

test("libro: las filas de conteo llevan dos decimales, como la planilla de RRHH", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(
      mockSupabase({
        employees: ONE_WORKER,
        statuses: [{ employee_id: "emp-1", work_date: "2026-08-17", code: "F" }],
      }),
      "SUPER_ADMIN",
      PERIOD
    )
  );
  const wb = XLSX.read(bytes, { type: "array", cellNF: true });
  const sheet = wb.Sheets[wb.SheetNames.at(-1)!];

  // Un total que sale "1" donde la planilla dice "1.00" es justo lo que impide
  // comparar las dos de un vistazo.
  for (const [row, label] of [[14, "Asistencia"], [15, "Faltas"], [16, "Vacaciones"], [17, "Licencia"]] as const) {
    const total = sheet[XLSX.utils.encode_cell({ r: row, c: 2 })];
    assert.equal(total.z, "#,##0.00;[Red]#,##0.00", `total de ${label}`);
  }
});

test("libro: la hoja se llama por el mes de cierre del período, como NOV25", async () => {
  const bytes = buildAttendanceExportWorkbook(
    await buildAttendanceExportData(mockSupabase({ employees: ONE_WORKER }), "SUPER_ADMIN", PERIOD)
  );
  const wb = XLSX.read(bytes, { type: "array" });
  // PERIOD cierra el 2026-08-23.
  assert.deepEqual(wb.SheetNames, ["RESUMEN", "PENDIENTES", "AGO26"]);
});

test("libro: abre con un resumen de remuneraciones y marca BORRADOR si el ciclo 16-15 no está cerrado", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      reportingPeriodStatus: "OPEN",
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses: [{ employee_id: "emp-1", work_date: "2026-08-14", code: "F" }],
      lates: [{ employee_id: "emp-1", work_date: "2026-08-14", detected_minutes: 10, payroll_minutes: 10 }],
    }),
    "SUPER_ADMIN",
    PAYROLL_PERIOD
  );
  const bytes = buildAttendanceExportWorkbook(data);
  const rows = readSheet(bytes, "RESUMEN");

  assert.match(String(rows[0][0]), /NÓMINA DE ASISTENCIA PARA REMUNERACIONES/);
  assert.match(String(rows[2][0]), /^BORRADOR/);
  assert.deepEqual(rows[4].slice(0, 5), ["Código Workera", "RUT", "Trabajador", "Área", "Días base"]);
  assert.match(String(rows[5][2]), /TRABAJADOR UNO/);
  assert.equal(rows[5][4], 30, "el ciclo de pago conserva la base mensual de 30 días");
  assert.equal(rows[5][5], 1);
  assert.equal(rows[5][10], 10 / 1_440);
});

test("libro: el resumen advierte salidas anticipadas y marcaciones incompletas pendientes", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((work_date) => !isWeekend(work_date))
    .map((work_date) => ({ employee_id: "emp-1", work_date, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      earlyDepartures: [
        { employee_id: "emp-1", work_date: "2026-08-17", detected_minutes: 30 },
      ],
      missingPunches: [
        { employee_id: "emp-1", work_date: "2026-08-18", status: "PENDING_CONTACT" },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const bytes = buildAttendanceExportWorkbook(data);
  const rows = readSheet(bytes, "RESUMEN");
  const detail = readSheet(bytes);
  const pending = readSheet(bytes, "PENDIENTES");

  assert.equal(rows[5][11], 0, "una salida pendiente no se convierte en descuento");
  assert.equal(rows[5][19], "17/08, 18/08");
  assert.equal(rows[5][18], "Revisar");
  assert.match(String(rows[5][20]), /Marcaciones incompletas por resolver: 1/);
  assert.match(String(rows[5][20]), /Salidas anticipadas por decidir: 1/);
  assert.equal(detail[19][2], 0);
  assert.equal(detail[19][3], "PEND.");
  assert.equal(pending.find((row) => row[6] === "Salida anticipada por resolver")?.[7], 30);
});

test("libro: una salida justificada y una flag histórica no crean falsos pendientes", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((work_date) => !isWeekend(work_date))
    .map((work_date) => ({ employee_id: "emp-1", work_date, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      earlyDepartures: [
        {
          employee_id: "emp-1",
          work_date: "2026-08-17",
          detected_minutes: 30,
          payroll_minutes: 0,
          payroll_effect: "DO_NOT_DEDUCT",
        },
      ],
      missingPunches: [
        {
          employee_id: "emp-1",
          work_date: "2026-08-18",
          status: "CONTACTED",
          attendanceCurrent: false,
        },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const rows = readSheet(buildAttendanceExportWorkbook(data), "RESUMEN");

  assert.equal(rows[5][11], 0);
  assert.equal(rows[5][18], "Sin pendientes");
});

test("libro: una ausencia sin cerrar nunca aparece como Sin pendientes", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((work_date) => !isWeekend(work_date))
    .map((work_date) => ({
      employee_id: "emp-1",
      work_date,
      code: work_date === "2026-08-18" || work_date === "2026-08-19" ? "L" : "P",
    }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      absences: [
        {
          employee_id: "emp-1",
          start_date: "2026-08-18",
          end_date: "2026-08-19",
          decision_status: "PENDING_DOCUMENT",
        },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const bytes = buildAttendanceExportWorkbook(data);
  const rows = readSheet(bytes, "RESUMEN");
  const detail = readSheet(bytes);

  assert.equal(rows[5][19], "18/08, 19/08");
  assert.equal(rows[5][18], "Revisar");
  assert.equal(rows[5][6], 0, "la licencia pendiente no descuenta días pagables");
  assert.equal(rows[5][7], 5, "hasta cerrar la decisión conserva la base de pago");
  assert.match(String(rows[5][20]), /Ausencias\/licencias por resolver: 2 día\(s\)/);
  assert.equal(detail[17][2], 0);
  assert.equal(detail[17][4], "PEND.");
  assert.equal(detail[17][5], "PEND.");
});

test("libro: una ausencia confirmada no crea un falso pendiente", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((work_date) => !isWeekend(work_date))
    .map((work_date) => ({ employee_id: "emp-1", work_date, code: "L" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      absences: [
        {
          employee_id: "emp-1",
          start_date: "2026-08-17",
          end_date: "2026-08-21",
          decision_status: "CONFIRMED",
        },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const rows = readSheet(buildAttendanceExportWorkbook(data), "RESUMEN");

  assert.equal(rows[5][18], "Sin pendientes");
  assert.doesNotMatch(String(rows[5][20]), /Ausencias\/licencias por resolver/);
});

test("libro: la última corrida parcial bloquea el pago aunque sobreviva un estado P anterior", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((workDate) => !isWeekend(workDate))
    .map((workDate) => ({ employee_id: "emp-1", work_date: workDate, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      ruleEngineRuns: [
        { work_date: "2026-08-18", status: "SUCCEEDED", started_at: "2026-08-18T18:00:00Z" },
        { work_date: "2026-08-18", status: "PARTIAL", started_at: "2026-08-18T19:00:00Z" },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const bytes = buildAttendanceExportWorkbook(data);
  const rows = readSheet(bytes, "RESUMEN");
  const pending = readSheet(bytes, "PENDIENTES");

  assert.ok(data.ruleEngineProblemDates.has("2026-08-18"));
  assert.match(String(rows[2][0]), /procesamiento incompleto en 1 fecha\(s\)/);
  assert.equal(rows[5][18], "Sin pendientes", "una falla global no se repite como incidencia personal");
  assert.ok(pending.some((row) => row[6] === "Procesamiento de asistencia incompleto"));
});

test("libro: una corrida posterior exitosa limpia la alerta de una falla antigua", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((workDate) => !isWeekend(workDate))
    .map((workDate) => ({ employee_id: "emp-1", work_date: workDate, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      ruleEngineRuns: [
        { work_date: "2026-08-18", status: "FAILED", started_at: "2026-08-18T18:00:00Z" },
        { work_date: "2026-08-18", status: "SUCCEEDED", started_at: "2026-08-18T19:00:00Z" },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const rows = readSheet(buildAttendanceExportWorkbook(data), "RESUMEN");

  assert.equal(data.ruleEngineProblemDates.has("2026-08-18"), false);
  assert.equal(rows[5][18], "Sin pendientes");
  assert.doesNotMatch(String(rows[5][20]), /Motor de reglas incompleto/);
});

test("libro: una fecha laboral sin corrida exitosa nunca aparece lista para pagar", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((workDate) => !isWeekend(workDate))
    .map((workDate) => ({ employee_id: "emp-1", work_date: workDate, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      ruleEngineRuns: [],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const rows = readSheet(buildAttendanceExportWorkbook(data), "RESUMEN");

  assert.match(String(rows[2][0]), /procesamiento incompleto en 5 fecha\(s\)/);
  assert.equal(rows[5][18], "Sin pendientes");
});

test("libro: detecta una corrida que cambió mientras se consultaban los datos", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((workDate) => !isWeekend(workDate))
    .map((workDate) => ({ employee_id: "emp-1", work_date: workDate, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
      ruleEngineRunsAfter: [
        { work_date: "2026-08-18", status: "SUCCEEDED", started_at: "2026-08-18T20:00:00Z" },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const rows = readSheet(buildAttendanceExportWorkbook(data), "RESUMEN");

  assert.ok(data.ruleEngineProblemDates.has("2026-08-18"));
  assert.match(String(rows[2][0]), /procesamiento incompleto en 1 fecha\(s\)/);
  assert.equal(rows[5][18], "Sin pendientes");
});

test("libro: un período cerrado se identifica como control de datos actuales, no como snapshot", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((work_date) => !isWeekend(work_date))
    .map((work_date) => ({ employee_id: "emp-1", work_date, code: "P" }));
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      reportingPeriodStatus: "CLOSED",
      schedules: MONDAY_FRIDAY_SCHEDULE,
      statuses,
    }),
    "SUPER_ADMIN",
    PAYROLL_PERIOD
  );
  const rows = readSheet(buildAttendanceExportWorkbook(data), "RESUMEN");

  assert.match(String(rows[2][0]), /^CONTROL — período cerrado/);
  assert.match(String(rows[3][0]), /datos actuales/);
  assert.match(String(rows[3][0]), /todavía no es una copia inmutable/);
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
  assert.equal(rows[14][5], "", "pero la fila Asistencia lo deja sin valor");
});

test("libro: Asistencia no cuenta el feriado como día trabajado", async () => {
  // Período de prueba: L-V = 5 días hábiles. Con el miércoles 19 feriado -> 4.
  const conFeriado = await buildSheet({ employees: ONE_WORKER, holidays: ["2026-08-19"] });
  const sinFeriado = await buildSheet({ employees: ONE_WORKER });
  assert.equal(sinFeriado[14][2], 5);
  assert.equal(conFeriado[14][2], 4);
});
