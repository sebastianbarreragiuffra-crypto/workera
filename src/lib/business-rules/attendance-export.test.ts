import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { strFromU8, unzipSync } from "fflate";
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
 * El exportador 2026 entrega una fila por trabajador, pendientes accionables y
 * una sábana diaria. Nunca inventa un estado: un día exigible sin dato
 * definitivo sale "?", nunca P/F asumido.
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
  organizationAssignments?: {
    employee_id: string;
    effective_from: string;
    effective_to?: string | null;
    is_primary?: boolean;
    code: string;
    name: string;
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
    if (table === "employee_org_assignments") {
      const configured = opts.organizationAssignments ?? opts.employees.map((employee) => ({
        employee_id: employee.id,
        effective_from: "2000-01-01",
        effective_to: null,
        is_primary: true,
        code: `AREA_${employee.group}`,
        name: employee.group,
      }));
      return configured.map((assignment) => ({
        employee_id: assignment.employee_id,
        effective_from: assignment.effective_from,
        effective_to: assignment.effective_to ?? null,
        is_primary: assignment.is_primary ?? true,
        company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
        organization_units: { code: assignment.code, name: assignment.name },
      }));
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
        if ((table === "rule_engine_runs" || table === "employee_org_assignments") && companyId) {
          rows = rows.filter((row) => row.company_id === companyId);
        }
        if (table === "employee_org_assignments" && filters.has("is_primary")) {
          rows = rows.filter((row) => row.is_primary === filters.get("is_primary"));
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

test("buildAttendanceExportData: centro de costo viene de la asignación organizacional primaria al cierre", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      organizationAssignments: [
        {
          employee_id: "emp-1",
          effective_from: "2026-01-01",
          effective_to: null,
          code: "CC-PLANTA",
          name: "Planta principal",
        },
      ],
    }),
    "SUPER_ADMIN",
    PERIOD
  );

  assert.equal(data.workers[0].costCenter, "CC-PLANTA — Planta principal");
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
// Libro 2026

function readWorkbook(bytes: Uint8Array) {
  return XLSX.read(bytes, { type: "array", cellNF: true, cellStyles: true, cellDates: false });
}

function readSheet(bytes: Uint8Array, sheetName: string): (string | number | null)[][] {
  const workbook = readWorkbook(bytes);
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null });
}

async function buildWorkbook(opts: MockOpts, period: AttendanceExportPeriod = PERIOD) {
  const data = await buildAttendanceExportData(mockSupabase(opts), "SUPER_ADMIN", period);
  return { data, bytes: buildAttendanceExportWorkbook(data) };
}

function workbookXml(bytes: Uint8Array, path: string): string {
  const archive = unzipSync(bytes);
  const entry = archive[path];
  assert.ok(entry, "falta " + path);
  return strFromU8(entry);
}

test("libro 2026: genera las tres hojas y no combina ninguna celda de las tablas", async () => {
  const { bytes } = await buildWorkbook({ employees: ONE_WORKER });
  const workbook = readWorkbook(bytes);

  assert.deepEqual(workbook.SheetNames, [
    "RESUMEN_NOMINA",
    "CONTROL_PENDIENTES",
    "MATRIZ_DIARIA_SABANA",
  ]);
  for (const name of workbook.SheetNames) {
    const merges = workbook.Sheets[name]["!merges"] ?? [];
    const tableHeaderRow = name === "CONTROL_PENDIENTES" ? 3 : 4;
    assert.ok(merges.every((range) => range.e.r < tableHeaderRow), name + " solo puede combinar metadatos sobre la tabla");
  }
});

test("libro 2026: resumen y sábana usan una sola fila por trabajador", async () => {
  const { bytes } = await buildWorkbook({
    employees: [
      ...ONE_WORKER,
      { id: "emp-2", display_name: "TRABAJADOR DOS", group: "INSTALLATION", rut: "22222222-2" },
    ],
  });
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.deepEqual(summary[4].slice(0, 5), [
    "RUT", "Nombre_Completo", "Horario_Jornada", "Centro_Costo", "Codigo_Workera",
  ]);
  assert.deepEqual(matrix[4].slice(0, 5), [
    "RUT", "Codigo_Workera", "Nombre_Completo", "Horario_Jornada", "Centro_Costo",
  ]);
  assert.equal(summary[5][1], "TRABAJADOR DOS");
  assert.equal(summary[6][1], "TRABAJADOR UNO");
  assert.equal(summary[7][1], "TOTAL EMPRESA");
  assert.equal(matrix.length, 7, "cinco filas de cabecera y dos personas");
  const summarySheet = readWorkbook(bytes).Sheets.RESUMEN_NOMINA;
  assert.match(String(summarySheet.F6.f), /MATCH\(\$E6,'MATRIZ_DIARIA_SABANA'!\$B\$6:\$B\$7,0\)/, "la conciliación usa código estable y resiste ordenación independiente");
});

test("libro 2026: la sábana tiene fechas contiguas y códigos oficiales en una fila", async () => {
  const statuses = [
    { employee_id: "emp-1", work_date: "2026-08-17", code: "P" },
    { employee_id: "emp-1", work_date: "2026-08-18", code: "F" },
    { employee_id: "emp-1", work_date: "2026-08-19", code: "V" },
    { employee_id: "emp-1", work_date: "2026-08-20", code: "L-M" },
    { employee_id: "emp-1", work_date: "2026-08-21", code: "P-L" },
  ];
  const { bytes } = await buildWorkbook({ employees: ONE_WORKER, schedules: MONDAY_FRIDAY_SCHEDULE, statuses });
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.equal(matrix[4].length, 12, "cinco columnas fijas más siete días");
  assert.deepEqual(matrix[5].slice(5, 12), ["P", "F", "V", "L-M", "P-L", "", ""]);
  assert.match(String(matrix[2][0]), /P=PRESENTE/);
  assert.match(String(matrix[2][0]), /\?=TARJETA NO MARCADA/);
});

test("libro 2026: fórmulas cuentan la matriz y escapan el signo ? como literal", async () => {
  const statuses = [
    { employee_id: "emp-1", work_date: "2026-08-17", code: "P" },
    { employee_id: "emp-1", work_date: "2026-08-18", code: "F" },
    { employee_id: "emp-1", work_date: "2026-08-19", code: "V" },
    { employee_id: "emp-1", work_date: "2026-08-20", code: "L" },
    { employee_id: "emp-1", work_date: "2026-08-22", code: "R" },
  ];
  const { bytes } = await buildWorkbook(
    { employees: ONE_WORKER, schedules: MONDAY_FRIDAY_SCHEDULE, statuses, reportingPeriodStatus: "CLOSED" },
    { ...PERIOD, type: "PAGO" }
  );
  const workbook = readWorkbook(bytes);
  const summary = workbook.Sheets.RESUMEN_NOMINA;

  assert.equal(summary.F6.v, 1);
  assert.equal(summary.F6.f, "COUNTIF(INDEX('MATRIZ_DIARIA_SABANA'!$F$6:$L$6,MATCH($E6,'MATRIZ_DIARIA_SABANA'!$B$6:$B$6,0),0),\"P\")");
  assert.equal(summary.G6.v, 1);
  assert.equal(summary.H6.v, 1);
  assert.equal(summary.I6.v, 0, "L-M se conserva separado de la licencia común");
  assert.equal(summary.J6.v, 1);
  assert.match(String(summary.AC6.f), /COUNTIF\(INDEX\('MATRIZ_DIARIA_SABANA'![^,]+,MATCH\(\$E6,[^,]+,0\),0\),"~\?"\)/);
  assert.doesNotMatch(String(summary.AC6.f), /,"\\?"\)/);
  assert.equal(summary.AC6.v, "BLOQUEADO POR PENDIENTES");
});

test("libro 2026: separa Workera, ajuste y total final para horas y bonos", async () => {
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    overtimes: [
      {
        employee_id: "emp-1",
        work_date: "2026-08-17",
        code: "OVERTIME_50",
        approved_minutes: 120,
        bonus_amount: 1_000,
      },
      {
        employee_id: "emp-1",
        work_date: "2026-08-20",
        code: "OVERTIME_100",
        approved_minutes: 180,
      },
    ],
  });
  const summary = readWorkbook(bytes).Sheets.RESUMEN_NOMINA;

  assert.deepEqual([summary.A6.v, summary.B6.v, summary.E6.v], ["11111111-1", "TRABAJADOR UNO", "WK-001"]);
  assert.equal(summary.K6.v, 120 / 1_440);
  assert.equal(summary.L6.v, 0);
  assert.equal(summary.M6.f, "K6+L6/1440");
  assert.equal(summary.M6.v, 120 / 1_440);
  assert.equal(summary.O6.v, 180 / 1_440);
  assert.equal(summary.Q6.f, "O6+P6/1440");
  assert.equal(summary.U6.v, 1_000);
  assert.equal(summary.W6.f, "U6+V6");
  assert.equal(summary.Y6.v, 1, "el monto agregado conserva sus días de origen");
  assert.equal(summary.Z6.v, "17/08");
  assert.equal(summary.K6.z, "[h]:mm");
  assert.equal(summary.U6.z, "\"$\"#,##0");
  assert.equal(summary.M7.f, "SUM(M6:M6)");
  assert.equal(summary.M7.t, "n", "el valor cacheado del total debe seguir siendo numérico");
});

test("libro 2026: ajustes tienen formato condicional real, paneles congelados y recálculo", async () => {
  const { bytes } = await buildWorkbook({ employees: ONE_WORKER });
  const summaryXml = workbookXml(bytes, "xl/worksheets/sheet1.xml");
  const stylesXml = workbookXml(bytes, "xl/styles.xml");
  const bookXml = workbookXml(bytes, "xl/workbook.xml");

  assert.match(summaryXml, /<[^>]*pane [^>]*xSplit="5"[^>]*ySplit="5"[^>]*topLeftCell="F6"/);
  assert.match(summaryXml, /conditionalFormatting sqref="L6:L6"/);
  assert.match(summaryXml, /<[^>]*formula>L6&lt;&gt;0<\/[^>]*formula>/);
  assert.match(summaryXml, /conditionalFormatting sqref="AC6:AC6"/);
  assert.match(stylesXml, /<[^>]*dxfs count="17">/);
  assert.match(bookXml, /calcMode="auto"[^>]*fullCalcOnLoad="1"[^>]*forceFullCalc="1"/);
});

test("libro 2026: un atraso pendiente nunca se convierte en descuento", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1" }],
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
    lates: [{ employee_id: "emp-1", work_date: "2026-08-17", detected_minutes: 15 }],
  });
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.match(workbookXml(bytes, "xl/worksheets/sheet1.xml"), /<[^>]*c r="S6"[^>]*>[\s\S]*?<[^>]*v>0<\/[^>]*v><\/[^>]*c>/);
  assert.equal(summary[5][26], 1);
  assert.ok(pending.some((row) => row[6] === "Atraso por resolver" && row[7] === 15));
});

test("libro 2026: licencia en trámite aparece como ? y no entra al total definitivo", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: date === "2026-08-18" ? "L" : "P" }));
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
    absences: [{
      employee_id: "emp-1",
      start_date: "2026-08-18",
      end_date: "2026-08-18",
      decision_status: "PENDING_DOCUMENT",
    }],
  });
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.equal(matrix[5][6], "?");
  assert.equal(summary[5][7], 0);
  assert.equal(summary[5][28], "SOLO CONTROL - NO PAGO");
  assert.match(String(summary[5][29]), /Ausencias\/licencias por resolver/);
});

test("libro 2026: código R y códigos desconocidos bloquean y quedan trazados", async () => {
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses: [{ employee_id: "emp-1", work_date: "2026-08-17", code: "R" }],
  });
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.equal(matrix[5][5], "R");
  assert.ok(pending.some((row) => String(row[6]).includes("Código diario R")));
});

test("libro 2026: fin de semana y feriado sin hechos quedan vacíos", async () => {
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    schedules: MONDAY_FRIDAY_SCHEDULE,
    holidays: ["2026-08-19"],
  });
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.equal(matrix[5][7], "", "feriado miércoles 19");
  assert.equal(matrix[5][10], "", "sábado 22");
  assert.equal(matrix[5][11], "", "domingo 23");
});

test("libro 2026: un hecho anterior al ingreso se vuelve ? y no afecta totales", async () => {
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], hire_date: "2026-08-19" }],
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses: [
      { employee_id: "emp-1", work_date: "2026-08-17", code: "F" },
      { employee_id: "emp-1", work_date: "2026-08-19", code: "P" },
    ],
  });
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.equal(matrix[5][5], "?");
  assert.equal(summary[5][6], 0);
  assert.ok(pending.some((row) => row[6] === "Hecho de asistencia anterior al ingreso"));
});

test("libro 2026: una corrida incompleta invalida el código diario anterior", async () => {
  const statuses = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes, data } = await buildWorkbook({
    employees: ONE_WORKER,
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
    ruleEngineRuns: [
      { work_date: "2026-08-18", status: "PARTIAL", started_at: "2026-08-18T19:00:00Z" },
    ],
  });
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.ok(data.ruleEngineProblemDates.has("2026-08-18"));
  assert.equal(matrix[5][6], "?");
  assert.ok(pending.some((row) => row[6] === "Procesamiento de asistencia incompleto"));
});

test("libro 2026: período 16-15 cerrado y sin pendientes queda aprobado para pago", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    reportingPeriodStatus: "CLOSED",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }, PAYROLL_PERIOD);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.match(String(summary[2][0]), /^CONTROL/);
  assert.equal(summary[5][28], "APROBADO PARA PAGO");
  assert.equal(pending[4][6], "Sin bloqueos detectados");
  assert.match(String(summary[3][0]), /no reemplaza el cierre formal ni un snapshot inmutable/);
});

test("libro 2026: período 16-15 abierto queda bloqueado aunque no haya incidencias personales", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    reportingPeriodStatus: "OPEN",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }, PAYROLL_PERIOD);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.equal(summary[5][28], "BLOQUEADO POR PENDIENTES");
  assert.ok(pending.some((row) => row[6] === "Período de pago abierto"));
});

test("libro 2026: centro de costo ausente bloquea y el estado superior no contradice el detalle", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    organizationAssignments: [],
    reportingPeriodStatus: "CLOSED",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }, PAYROLL_PERIOD);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.equal(summary[5][3], "");
  assert.equal(summary[5][28], "BLOQUEADO POR PENDIENTES");
  assert.match(String(summary[2][0]), /^REVISAR/);
  assert.ok(pending.some((row) => row[6] === "Centro de costo ausente"));
});

test("libro 2026: RUT o código Workera ausente bloquea una pre-nómina", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    reportingPeriodStatus: "CLOSED",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }, PAYROLL_PERIOD);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.equal(summary[5][28], "BLOQUEADO POR PENDIENTES");
  assert.ok(pending.some((row) => row[6] === "RUT ausente"));
});

test("libro 2026: una persona exenta no genera falsos signos ?", async () => {
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    timeControlPolicies: [{
      employee_id: "emp-1",
      effective_from: PERIOD.startDate,
      effective_to: PERIOD.endDate,
      policy_code: "EXEMPT_FROM_TIME_CONTROL",
    }],
  });
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.deepEqual(matrix[5].slice(5, 12), ["", "", "", "", "", "", ""]);
  assert.match(String(summary[5][29]), /Exento de marcación/);
});

test("libro 2026: sin trabajadores sigue siendo un XLSX válido", async () => {
  const { bytes } = await buildWorkbook({ employees: [] });
  const workbook = readWorkbook(bytes);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.deepEqual(workbook.SheetNames, ["RESUMEN_NOMINA", "CONTROL_PENDIENTES", "MATRIZ_DIARIA_SABANA"]);
  assert.equal(summary[5][1], "TOTAL EMPRESA");
  assert.equal(matrix.length, 5);
});

test("buildAttendanceExportData: expone los feriados del período", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({ employees: ONE_WORKER, holidays: ["2026-08-19"] }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.ok(data.holidays.has("2026-08-19"));
});
