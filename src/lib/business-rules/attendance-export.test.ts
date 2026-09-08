import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { strFromU8, unzipSync } from "fflate";
import {
  buildAttendanceExportData as buildAttendanceExportDataForCompany,
  buildAttendanceExportWorkbook,
  calendarDaysBetween,
  getAttendanceExportCloseReadiness,
  isWeekend,
} from "./attendance-export";
import type { AttendanceExportPeriod } from "./attendance-export-periods";
import { canonicalRosterSha256 } from "../employees/arcotex-pilot-roster";
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
  punches?: {
    employee_id: string;
    work_date: string;
    actual_clock_in: string | null;
    actual_clock_out: string | null;
    corrected_clock_in?: string | null;
    corrected_clock_out?: string | null;
  }[];
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
    decision_status?: "FULLY_APPROVED" | "PARTIALLY_APPROVED" | "REJECTED";
    reason?: string;
  }[];
  missingPunches?: {
    employee_id: string;
    work_date: string;
    status: "PENDING_CONTACT" | "CONTACTED" | "UNRESOLVED";
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
    rrhh_confirmed_at?: string | null;
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
  groupAssignments?: {
    employee_id: string;
    effective_from: string;
    effective_to?: string | null;
    group: "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION";
    company_id?: string;
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
    if (table === "attendance_records") {
      return (opts.punches ?? []).map((row) => ({
        employee_id: row.employee_id,
        work_date: row.work_date,
        actual_clock_in: row.actual_clock_in,
        actual_clock_out: row.actual_clock_out,
        attendance_corrections:
          row.corrected_clock_in === undefined && row.corrected_clock_out === undefined
            ? []
            : [{
                corrected_clock_in: row.corrected_clock_in ?? null,
                corrected_clock_out: row.corrected_clock_out ?? null,
                is_current: true,
              }],
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
            : [{
                payroll_minutes: r.payroll_minutes,
                payroll_effect: r.payroll_effect ?? "DEDUCT",
                justified: (r.payroll_effect ?? "DEDUCT") === "DO_NOT_DEDUCT",
                reason: "Motivo ficticio",
                decided_at: "2026-09-06T12:00:00.000Z",
                decided_by_profile: { display_name: "SUPERVISOR FICTICIO" },
                is_current: true,
              }],
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
                  reason_category: (row.payroll_effect ?? "DEDUCT") === "DO_NOT_DEDUCT" ? "OTHER_JUSTIFIED" : "UNJUSTIFIED",
                  reason: "Motivo ficticio",
                  decided_at: "2026-09-06T12:00:00.000Z",
                  decided_by_profile: { display_name: "SUPERVISOR FICTICIO" },
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
                rejected_minutes: Math.max(0, (r.candidate_minutes ?? r.approved_minutes ?? 0) - r.approved_minutes),
                decision_status: r.decision_status ?? "FULLY_APPROVED",
                reason: r.reason ?? "Decisión ficticia de prueba",
                decided_at: "2026-09-06T12:00:00.000Z",
                decided_by_profile: { display_name: "SUPERVISOR FICTICIO" },
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
    if (table === "employee_group_assignments") {
      const configured = opts.groupAssignments ?? opts.employees.map((employee) => ({
        employee_id: employee.id,
        effective_from: "2000-01-01",
        effective_to: null,
        group: employee.group,
        company_id: employee.company_id ?? ARCOTEX_WORKFORCE_COMPANY_ID,
      }));
      return configured.map((assignment) => ({
        employee_id: assignment.employee_id,
        effective_from: assignment.effective_from,
        effective_to: assignment.effective_to ?? null,
        employee_groups: {
          code: assignment.group,
          company_id: assignment.company_id ?? ARCOTEX_WORKFORCE_COMPANY_ID,
        },
      }));
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

test("buildAttendanceExportData: el padrón aprobado limita la exportación sin alterar a las demás personas", async () => {
  const employees = [
    { id: "emp-approved", display_name: "PERSONA APROBADA", group: "PRODUCTION" },
    { id: "emp-outside", display_name: "PERSONA FUERA DEL PILOTO", group: "PRODUCTION" },
  ];
  const data = await buildAttendanceExportDataForCompany(
    mockSupabase({ employees }),
    "ADMIN_RRHH",
    PERIOD,
    ARCOTEX_WORKFORCE_COMPANY_ID,
    { employeeIds: ["emp-approved"] },
  );

  assert.deepEqual(data.workers.map((worker) => worker.employeeId), ["emp-approved"]);
  assert.equal(employees.length, 2, "el filtro no elimina ni desactiva filas del padrón fuente");
});

test("buildAttendanceExportData: la huella autorizada conserva todo el padrón explícito y llega al libro", async () => {
  const employees = [
    { id: "emp-active", external_workera_id: "WK-002", display_name: "PERSONA ACTIVA", group: "PRODUCTION" },
    {
      id: "emp-inactive",
      external_workera_id: "WK-001",
      display_name: "PERSONA INACTIVA",
      group: "PRODUCTION",
      active: false,
      hire_date: "2099-01-01",
    },
  ];
  const expectedEmployeeCodeSha256 = canonicalRosterSha256(["WK-001", "WK-002"]);
  const data = await buildAttendanceExportDataForCompany(
    mockSupabase({ employees }),
    "ADMIN_RRHH",
    PERIOD,
    ARCOTEX_WORKFORCE_COMPANY_ID,
    { employeeIds: ["emp-active", "emp-inactive"], expectedEmployeeCodeSha256 },
  );

  assert.deepEqual(data.workers.map((worker) => worker.employeeId).sort(), ["emp-active", "emp-inactive"]);
  assert.equal(data.rosterCount, 2);
  assert.equal(data.rosterSha256, expectedEmployeeCodeSha256);

  const book = XLSX.read(buildAttendanceExportWorkbook(data), { type: "array" });
  const metadata = new Map(
    XLSX.utils.sheet_to_json<(string | number)[]>(book.Sheets._GESTORA_TECNICA, { header: 1, raw: false })
      .map((row) => [String(row[0] ?? ""), String(row[1] ?? "")]),
  );
  assert.equal(metadata.get("Cantidad padrón autorizado"), "2");
  assert.equal(metadata.get("Huella padrón autorizado"), expectedEmployeeCodeSha256);

  await assert.rejects(
    buildAttendanceExportDataForCompany(
      mockSupabase({ employees }),
      "ADMIN_RRHH",
      PERIOD,
      ARCOTEX_WORKFORCE_COMPANY_ID,
      { employeeIds: ["emp-active", "emp-inactive"], expectedEmployeeCodeSha256: "0".repeat(64) },
    ),
    /no corresponden al padrón autorizado/i,
  );
});

test("buildAttendanceExportData: falla cerrado si un ID aprobado no pertenece al alcance autorizado", async () => {
  await assert.rejects(
    buildAttendanceExportDataForCompany(
      mockSupabase({ employees: ONE_WORKER }),
      "ADMIN_RRHH",
      PERIOD,
      ARCOTEX_WORKFORCE_COMPANY_ID,
      { employeeIds: ["emp-1", "emp-no-autorizado"] },
    ),
    /no pertenece íntegramente/,
  );
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

test("buildAttendanceExportData: conserva minutos reales aunque el pagable quede topado", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      punches: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        actual_clock_in: "2026-08-17T07:30:00-04:00",
        actual_clock_out: "2026-08-17T19:01:00-04:00",
      }],
      overtimes: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        code: "OVERTIME_50",
        candidate_minutes: 121,
        approved_minutes: 120,
      }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  const day = data.workers[0].days.get("2026-08-17");
  assert.equal(day?.recordedMinutes, 691);
  assert.equal(day?.overtime50CandidateMinutes, 121);
  assert.equal(day?.overtime50Minutes, 120);
});

test("libro 2026: el tope diario usa el grupo histórico y no la ficha actual", async () => {
  const period: AttendanceExportPeriod = {
    type: "SEMANAL",
    startDate: "2026-08-17",
    endDate: "2026-08-24",
    label: "Semana histórica ficticia",
  };
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: [{ id: "emp-1", display_name: "TRABAJADOR UNO", group: "INSTALLATION" }],
      groupAssignments: [
        { employee_id: "emp-1", effective_from: "2020-01-01", effective_to: "2026-08-23", group: "PRODUCTION" },
        { employee_id: "emp-1", effective_from: "2026-08-24", group: "INSTALLATION" },
      ],
      overtimes: [{
        employee_id: "emp-1",
        work_date: "2026-08-23",
        code: "OVERTIME_100",
        candidate_minutes: 60,
        approved_minutes: 60,
      }],
    }),
    "SUPER_ADMIN",
    period,
  );
  const workbook = readWorkbook(buildAttendanceExportWorkbook(data));
  assert.match(String(workbook.Sheets.RESUMEN_NOMINA.P6.v), /tope 0 min/);
});

test("buildAttendanceExportData: usa la corrección vigente sin alterar la marca cruda", async () => {
  const data = await buildAttendanceExportData(
    mockSupabase({
      employees: ONE_WORKER,
      punches: [{
        employee_id: "emp-1",
        work_date: "2026-08-17",
        actual_clock_in: "2026-08-17T07:45:00-04:00",
        actual_clock_out: "2026-08-17T17:00:00-04:00",
        corrected_clock_in: "2026-08-17T07:30:00-04:00",
      }],
    }),
    "SUPER_ADMIN",
    PERIOD
  );
  assert.equal(data.workers[0].days.get("2026-08-17")?.recordedMinutes, 570);
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
    "_GESTORA_TECNICA",
  ]);
  for (const name of workbook.SheetNames) {
    const merges = workbook.Sheets[name]["!merges"] ?? [];
    const tableHeaderRow = name === "CONTROL_PENDIENTES" ? 3 : name === "_GESTORA_TECNICA" ? 0 : 4;
    assert.ok(merges.every((range) => range.e.r < tableHeaderRow), name + " solo puede combinar metadatos sobre la tabla");
  }
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");
  assert.deepEqual(pending[3], [
    "Alcance", "Prioridad", "Estado", "Código Workera", "RUT", "Nombre completo",
    "Área", "Centro de costo", "Fecha", "Incidencia", "Cantidad", "Unidad",
    "Responsable", "Decisión", "Motivo", "Fecha resolución", "Acción requerida",
  ]);
});

test("libro 2026: identifica y conserva exactamente los cuatro rangos descargables", async () => {
  const periods: AttendanceExportPeriod[] = [
    { type: "DIARIO", startDate: "2026-08-17", endDate: "2026-08-17", label: "Día de prueba" },
    PERIOD,
    { type: "QUINCENAL", startDate: "2026-08-01", endDate: "2026-08-15", label: "Quincena de prueba" },
    PAYROLL_PERIOD,
  ];

  for (const period of periods) {
    const { bytes } = await buildWorkbook({ employees: ONE_WORKER }, period);
    const workbook = readWorkbook(bytes);
    const metadata = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets._GESTORA_TECNICA, {
      header: 1,
      defval: "",
    });

    assert.deepEqual(workbook.SheetNames.slice(0, 3), [
      "RESUMEN_NOMINA",
      "CONTROL_PENDIENTES",
      "MATRIZ_DIARIA_SABANA",
    ]);
    assert.equal(metadata[2][1], period.type);
    assert.equal(metadata[3][1], period.startDate);
    assert.equal(metadata[4][1], period.endDate);
    assert.equal(workbook.Workbook?.Sheets?.[3]?.Hidden, 2, "la identidad técnica no se expone como hoja editable");
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
    "Estado", "RUT", "Nombre completo", "Área", "Centro de costo",
  ]);
  assert.deepEqual(matrix[4].slice(0, 5), [
    "RUT", "Código Workera", "Nombre completo", "Jornada", "Centro de costo",
  ]);
  assert.equal(summary[5][2], "TRABAJADOR DOS");
  assert.equal(summary[6][2], "TRABAJADOR UNO");
  assert.equal(summary[7][2], "TOTAL EMPRESA");
  assert.equal(matrix.length, 7, "cinco filas de cabecera y dos personas");
  const summarySheet = readWorkbook(bytes).Sheets.RESUMEN_NOMINA;
  assert.match(String(summarySheet.G6.f), /MATCH\(\$AB6,'MATRIZ_DIARIA_SABANA'!\$B\$6:\$B\$7,0\)/, "la conciliación usa código estable y resiste ordenación independiente");
});

test("libro 2026: separa horas ordinarias, HH50 reales y HH50 pagables", async () => {
  const { bytes } = await buildWorkbook({
    employees: ONE_WORKER,
    punches: [{
      employee_id: "emp-1",
      work_date: "2026-08-17",
      actual_clock_in: "2026-08-17T07:30:00-04:00",
      actual_clock_out: "2026-08-17T19:01:00-04:00",
    }],
    overtimes: [{
      employee_id: "emp-1",
      work_date: "2026-08-17",
      code: "OVERTIME_50",
      candidate_minutes: 121,
      approved_minutes: 120,
    }],
  });
  const summary = readWorkbook(bytes).Sheets.RESUMEN_NOMINA;
  const control = readSheet(bytes, "CONTROL_PENDIENTES");
  assert.equal(summary.H6.v, 570 / 1_440, "H conserva sólo el tramo ordinario registrado");
  assert.equal(summary.I6.v, 120 / 1_440, "I conserva lo pagable");
  assert.equal(summary.Q6.v, 121 / 1_440, "Q conserva lo realmente registrado");
  assert.match(String(summary.P6.v), /Alerta por exceso sobre tope HE/);
  assert.ok(control.some((row) => row[2] === "RESUELTO" && String(row[9]).includes("HH50: real 121 min · aprobado 120 min · tope 120 min")));
});

test("libro 2026: muestra acumulados semanales original y descontable de atrasos y salidas", async () => {
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1" }],
    lates: [
      { employee_id: "emp-1", work_date: "2026-07-20", detected_minutes: 10, payroll_minutes: 0, payroll_effect: "DO_NOT_DEDUCT" },
      { employee_id: "emp-1", work_date: "2026-07-22", detected_minutes: 15, payroll_minutes: 15 },
      { employee_id: "emp-1", work_date: "2026-08-03", detected_minutes: 20, payroll_minutes: 20 },
    ],
    earlyDepartures: [
      { employee_id: "emp-1", work_date: "2026-07-21", detected_minutes: 12, payroll_minutes: 0, payroll_effect: "DO_NOT_DEDUCT" },
      { employee_id: "emp-1", work_date: "2026-07-24", detected_minutes: 8, payroll_minutes: 8 },
    ],
  }, PAYROLL_PERIOD);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const summaryCells = readWorkbook(bytes).Sheets.RESUMEN_NOMINA;

  assert.equal(summary[4][31], "Atrasos por semana (original · descontable)");
  assert.equal(summary[4][32], "Salidas por semana (original · descontable)");
  assert.match(String(summary[5][31]), /20\/07–26\/07: original 25 min · descontable 15 min/);
  assert.match(String(summary[5][31]), /03\/08–09\/08: original 20 min · descontable 20 min/);
  assert.match(String(summary[5][32]), /20\/07–26\/07: original 20 min · descontable 8 min/);
  assert.equal(summaryCells.K6.v, 35 / 1_440);
  assert.equal(summaryCells.L6.v, 8 / 1_440);
  const control = readSheet(bytes, "CONTROL_PENDIENTES");
  const resolved = control.find((row) => row[2] === "RESUELTO" && String(row[9]).startsWith("Atraso:"));
  assert.ok(resolved);
  assert.equal(resolved?.[12], "SUPERVISOR FICTICIO");
  assert.equal(resolved?.[14], "Motivo ficticio");
  assert.equal(resolved?.[15], "2026-09-06T12:00:00.000Z");
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

  assert.equal(summary.G6.v, 1);
  assert.equal(summary.G6.f, "COUNTIF(INDEX('MATRIZ_DIARIA_SABANA'!$F$6:$L$6,MATCH($AB6,'MATRIZ_DIARIA_SABANA'!$B$6:$B$6,0),0),\"P\")");
  assert.match(String(summary.A6.f), /COUNTIF\(INDEX\('MATRIZ_DIARIA_SABANA'![^,]+,MATCH\(\$AB6,[^,]+,0\),0\),"~\?"\)/);
  assert.doesNotMatch(String(summary.A6.f), /,"\\?"\)/);
  assert.equal(summary.A6.v, "BLOQUEADO");
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

  assert.deepEqual([summary.B6.v, summary.C6.v, summary.AB6.v], ["11111111-1", "TRABAJADOR UNO", "WK-001"]);
  assert.equal(summary.Q6.v, 120 / 1_440);
  assert.equal(summary.R6.v, 0);
  assert.equal(summary.I6.f, "AD6+R6/1440");
  assert.equal(summary.I6.v, 120 / 1_440);
  assert.equal(summary.T6.v, 180 / 1_440);
  assert.equal(summary.J6.f, "AE6+U6/1440");
  assert.equal(summary.W6.v, 1_000);
  assert.equal(summary.N6.f, "W6+X6");
  assert.equal(summary.M6.v, 1, "el monto agregado conserva sus días de origen");
  assert.equal(summary.Z6.v, "17/08");
  assert.equal(summary.Q6.z, "[h]:mm");
  assert.equal(summary.W6.z, "\"$\"#,##0");
  assert.equal(summary.I7.f, "SUM(I6:I6)");
  assert.equal(summary.I7.t, "n", "el valor cacheado del total debe seguir siendo numérico");
  assert.equal(summary["!cols"]?.[16]?.hidden, undefined, "las HH50 reales deben ser visibles");
  assert.equal(summary["!cols"]?.[17]?.hidden, undefined, "el ajuste HH50 debe ser visible y editable");
  assert.equal(summary["!cols"]?.[24]?.hidden, undefined, "el motivo de bono debe ser visible y editable");
  assert.equal(summary["!cols"]?.[28]?.hidden, true, "el identificador técnico permanece oculto");
});

test("libro 2026: reaplica el último ajuste aceptado sin reemplazar la fuente Workera", async () => {
  const data = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    overtimes: [{
      employee_id: "emp-1",
      work_date: "2026-08-03",
      code: "OVERTIME_50",
      candidate_minutes: 121,
      approved_minutes: 120,
    }],
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  data.workbookAdjustments = [
    {
      employeeId: "emp-1",
      field: "Ajuste HH50 (minutos)",
      value: -30,
      sourceValueAtAcceptance: 120 / 1_440,
      versionNumber: 1,
      decidedAt: "2026-09-06T12:00:00.000Z",
    },
    {
      employeeId: "emp-1",
      field: "Motivo ajuste HH50",
      value: "Corrección ficticia autorizada",
      sourceValueAtAcceptance: null,
      versionNumber: 1,
      decidedAt: "2026-09-06T12:00:00.000Z",
    },
  ];

  const summary = readWorkbook(buildAttendanceExportWorkbook(data)).Sheets.RESUMEN_NOMINA;
  assert.equal(summary.Q6.v, 121 / 1_440, "conserva los minutos reales");
  assert.equal(summary.AD6.v, 120 / 1_440, "conserva el pagable automático de Workera");
  assert.equal(summary.R6.v, -30, "reaplica el ajuste empresarial aceptado");
  assert.equal(summary.S6.v, "Corrección ficticia autorizada");
  assert.equal(summary.I6.f, "AD6+R6/1440");
  assert.equal(summary.I6.v, 90 / 1_440, "el total final suma fuente y ajuste una sola vez");
});

test("libro 2026: detecta conflicto de tres vías y conserva provisionalmente el ajuste RR. HH.", async () => {
  const data = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    overtimes: [{
      employee_id: "emp-1",
      work_date: "2026-08-03",
      code: "OVERTIME_50",
      candidate_minutes: 120,
      approved_minutes: 120,
    }],
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  data.workbookAdjustments = [
    {
      employeeId: "emp-1",
      field: "Ajuste HH50 (minutos)",
      value: 30,
      sourceValueAtAcceptance: 60 / 1_440,
      versionNumber: 2,
      decidedAt: "2026-09-06T13:00:00.000Z",
    },
    {
      employeeId: "emp-1",
      field: "Motivo ajuste HH50",
      value: "Criterio RR. HH. ficticio",
      sourceValueAtAcceptance: null,
      versionNumber: 2,
      decidedAt: "2026-09-06T13:00:00.000Z",
    },
  ];

  const bytes = buildAttendanceExportWorkbook(data);
  const summary = readWorkbook(bytes).Sheets.RESUMEN_NOMINA;
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");
  const conflict = pending.find((row) => row[9] === "Conflicto Workera/RR. HH. en HH50");
  assert.equal(summary.R6.v, -30, "el delta se recalcula para conservar el valor final decidido por RR. HH.");
  assert.equal(summary.I6.v, 90 / 1_440, "Workera no pisa el total final previo de RR. HH.");
  assert.equal(summary.A6.v, "BLOQUEADO");
  assert.ok(conflict);
  assert.match(String(conflict?.[16]), /conservar el total final y actualizar su motivo mantiene RR\. HH\.; dejar el ajuste en 0 acepta Workera; otro total registra una tercera decisión/);
});

test("libro 2026: reaplica un código diario por trabajador y fecha, y alerta si Workera cambió", async () => {
  const data = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    statuses: [{ employee_id: "emp-1", work_date: "2026-08-03", code: "F" }],
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  data.workbookAdjustments = [{
    employeeId: "emp-1",
    workDate: "2026-08-03",
    field: "Código asistencia",
    value: "F-J",
    sourceValueAtAcceptance: "P",
    versionNumber: 3,
    decidedAt: "2026-09-06T14:00:00.000Z",
  }];

  const bytes = buildAttendanceExportWorkbook(data);
  const workbook = readWorkbook(bytes);
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");
  const conflict = pending.find((row) => row[9] === "Conflicto Workera/RR. HH. en código diario");

  assert.equal(workbook.Sheets.MATRIZ_DIARIA_SABANA.X6.v, "F-J", "la decisión diaria aceptada prevalece provisionalmente");
  assert.equal(workbook.Sheets.RESUMEN_NOMINA.A6.v, "BLOQUEADO");
  const conflictDate = conflict?.[8] as unknown;
  assert.ok(conflictDate instanceof Date);
  assert.equal(conflictDate.toISOString().slice(0, 10), "2026-08-03", "la incidencia conserva la fecha estable");
  assert.match(String(conflict?.[16]), /aceptar Workera o ingresar un tercer código oficial/);
});

test("cierre 16-15: un ajuste diario aceptado a ? permanece bloqueante en el gate servidor", async () => {
  const data = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    statuses: [{ employee_id: "emp-1", work_date: "2026-08-03", code: "P" }],
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  data.workbookAdjustments = [{
    employeeId: "emp-1",
    workDate: "2026-08-03",
    field: "Código asistencia",
    value: "?",
    sourceValueAtAcceptance: "P",
    versionNumber: 4,
    decidedAt: "2026-09-06T15:00:00.000Z",
  }];
  data.days = ["2026-08-03"];
  data.reportingPeriodStatus = "READY_TO_CLOSE";
  data.workers[0].costCenter = "CC FICTICIO";
  data.workers[0].scheduleCoveredDates.add("2026-08-03");
  data.workers[0].scheduledDates.add("2026-08-03");

  const readiness = getAttendanceExportCloseReadiness(data);
  assert.equal(readiness.ready, false);
  assert.ok(
    readiness.issues.some((issue) =>
      /Estado de asistencia sin resolver|Código diario \?/.test(issue),
    ),
  );
});

test("libro 2026: ajustes tienen formato condicional real, paneles congelados y recálculo", async () => {
  const { bytes } = await buildWorkbook({ employees: ONE_WORKER });
  const archive = unzipSync(bytes);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const summaryXml = workbookXml(bytes, "xl/worksheets/sheet1.xml");
  const stylesXml = workbookXml(bytes, "xl/styles.xml");
  const bookXml = workbookXml(bytes, "xl/workbook.xml");
  const relationshipsXml = workbookXml(bytes, "xl/_rels/workbook.xml.rels");
  const contentTypesXml = workbookXml(bytes, "[Content_Types].xml");

  assert.match(summaryXml, /<[^>]*pane [^>]*xSplit="5"[^>]*ySplit="5"[^>]*topLeftCell="F6"/);
  assert.match(summaryXml, /<[^>]*pageMargins [^>]*left="0\.25"[^>]*right="0\.25"/);
  assert.match(summaryXml, /<[^>]*pageSetup [^>]*orientation="landscape"[^>]*fitToWidth="1"[^>]*fitToHeight="0"/);
  assert.match(String(summary[3][0]), /Colación: referencia declarativa de 40 minutos; no se descuenta/);
  assert.match(summaryXml, /conditionalFormatting sqref="R6:R6"/);
  assert.match(summaryXml, /<[^>]*formula>R6&lt;&gt;0<\/[^>]*formula>/);
  assert.match(summaryXml, /conditionalFormatting sqref="A6:A6"/);
  assert.match(stylesXml, /<[^>]*dxfs count="18">/);
  assert.match(bookXml, /calcMode="auto"[^>]*fullCalcOnLoad="1"[^>]*forceFullCalc="1"/);
  assert.deepEqual(
    Object.keys(archive).filter((path) => /^xl\/metadata\d*\.xml$/.test(path)),
    [],
    "no conserva metadata Office 2017 sin referencias",
  );
  assert.doesNotMatch(relationshipsXml, /sheetMetadata/);
  assert.doesNotMatch(contentTypesXml, /sheetMetadata/);
});

test("libro 2026: fórmulas, filtros y estilos crecen con la dotación sin un límite fijo", async () => {
  for (const workerCount of [1, 3, 12]) {
    const employees = Array.from({ length: workerCount }, (_, index) => ({
      id: `emp-${index + 1}`,
      external_workera_id: `WK-${String(index + 1).padStart(3, "0")}`,
      display_name: `TRABAJADOR ${String(index + 1).padStart(2, "0")}`,
      group: index % 2 === 0 ? "PRODUCTION" as const : "INSTALLATION" as const,
      rut: `${String(index + 1).padStart(8, "0")}-${index % 10}`,
    }));
    const { bytes } = await buildWorkbook({ employees });
    const workbook = readWorkbook(bytes);
    const summary = workbook.Sheets.RESUMEN_NOMINA;
    const matrix = workbook.Sheets.MATRIZ_DIARIA_SABANA;
    const totalRow = 6 + workerCount;

    assert.equal(summary[`C${totalRow}`].v, "TOTAL EMPRESA");
    assert.equal(summary[`G${totalRow}`].f, `SUM(G6:G${5 + workerCount})`);
    assert.equal(summary["!autofilter"]?.ref, `A5:AG${5 + workerCount}`);
    assert.equal(matrix["!autofilter"]?.ref, `A5:L${5 + workerCount}`);
    assert.match(workbookXml(bytes, "xl/worksheets/sheet1.xml"), new RegExp(`conditionalFormatting sqref="A6:A${5 + workerCount}"`));
  }
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

  assert.match(workbookXml(bytes, "xl/worksheets/sheet1.xml"), /<[^>]*c r="K6"[^>]*>[\s\S]*?<[^>]*v>0<\/[^>]*v><\/[^>]*c>/);
  assert.equal(summary[5][14], 1);
  assert.ok(pending.some((row) => row[9] === "Atraso por resolver" && row[10] === 15));
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
  assert.equal(readWorkbook(bytes).Sheets.RESUMEN_NOMINA.K6.v, 0);
  assert.equal(summary[5][0], "REVISAR");
  assert.match(String(summary[5][15]), /Ausencias\/licencias por resolver/);
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
  assert.ok(pending.some((row) => String(row[9]).includes("Código diario R")));
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
  assert.equal(summary[5][6], 1);
  assert.ok(pending.some((row) => row[9] === "Hecho de asistencia anterior al ingreso"));
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
  assert.ok(pending.some((row) => row[9] === "Procesamiento de asistencia incompleto"));
});

test("libro 2026: período 16-15 cerrado y sin pendientes queda cerrado, nunca autoaprobado", async () => {
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
  assert.equal(summary[5][0], "CERRADO");
  assert.equal(pending[4][9], "Sin bloqueos detectados");
  assert.match(String(summary[3][0]), /no reemplaza el cierre formal ni un snapshot inmutable/);
});

test("libro 2026: período 16-15 abierto y conciliado queda listo para revisión, no aprobado", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    reportingPeriodStatus: "OPEN",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }, PAYROLL_PERIOD);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const pending = readSheet(bytes, "CONTROL_PENDIENTES");

  assert.match(String(summary[2][0]), /^REVISAR —/);
  assert.doesNotMatch(JSON.stringify(summary), /BORRADOR/);
  assert.equal(summary[5][0], "LISTO PARA REVISIÓN RR. HH.");
  assert.equal(pending[4][9], "Sin bloqueos detectados");
  assert.doesNotMatch(String(pending[2][0]), /\(s\)/, "el texto visible usa plurales humanos, no abreviaturas técnicas");
});

test("libro 2026: READY_TO_CLOSE refleja la aprobación explícita de RR. HH.", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const { bytes } = await buildWorkbook({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    reportingPeriodStatus: "READY_TO_CLOSE",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }, PAYROLL_PERIOD);

  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  assert.equal(summary[5][0], "APROBADO POR RR. HH.");
});

test("cierre 16-15: vuelve a calcular pendientes y sólo habilita READY_TO_CLOSE conciliado", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const clean = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    reportingPeriodStatus: "READY_TO_CLOSE",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  assert.deepEqual(getAttendanceExportCloseReadiness(clean), {
    ready: true,
    pendingCount: 0,
    issues: [],
  });

  const withPending = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    reportingPeriodStatus: "READY_TO_CLOSE",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
    lates: [{ employee_id: "emp-1", work_date: "2026-08-03", detected_minutes: 9 }],
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  const blocked = getAttendanceExportCloseReadiness(withPending);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.pendingCount, 1);
  assert.match(blocked.issues.join(" "), /Atraso por resolver/);
});

test("cierre 16-15: una marcación UNRESOLVED sigue siendo ? y bloquea aprobación", async () => {
  const statuses = calendarDaysBetween(PAYROLL_PERIOD.startDate, PAYROLL_PERIOD.endDate)
    .filter((date) => !isWeekend(date))
    .map((date) => ({ employee_id: "emp-1", work_date: date, code: "P" }));
  const data = await buildAttendanceExportData(mockSupabase({
    employees: [{ ...ONE_WORKER[0], rut: "11111111-1", external_workera_id: "WK-001" }],
    reportingPeriodStatus: "READY_TO_CLOSE",
    schedules: MONDAY_FRIDAY_SCHEDULE,
    statuses,
    missingPunches: [{ employee_id: "emp-1", work_date: "2026-07-20", status: "UNRESOLVED" }],
  }), "ADMIN_RRHH", PAYROLL_PERIOD);
  const blocked = getAttendanceExportCloseReadiness(data);
  assert.equal(blocked.ready, false);
  assert.match(blocked.issues.join(" "), /Marcación incompleta/);
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

  assert.equal(summary[5][4], "");
  assert.equal(summary[5][0], "BLOQUEADO");
  assert.match(String(summary[2][0]), /^REVISAR/);
  assert.ok(pending.some((row) => row[9] === "Centro de costo ausente"));
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

  assert.equal(summary[5][0], "BLOQUEADO");
  assert.ok(pending.some((row) => row[9] === "RUT ausente"));
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
  assert.match(String(summary[5][15]), /Exento de marcación/);
});

test("libro 2026: sin trabajadores sigue siendo un XLSX válido", async () => {
  const { bytes } = await buildWorkbook({ employees: [] });
  const workbook = readWorkbook(bytes);
  const summary = readSheet(bytes, "RESUMEN_NOMINA");
  const matrix = readSheet(bytes, "MATRIZ_DIARIA_SABANA");

  assert.deepEqual(workbook.SheetNames, ["RESUMEN_NOMINA", "CONTROL_PENDIENTES", "MATRIZ_DIARIA_SABANA", "_GESTORA_TECNICA"]);
  assert.equal(summary[5][2], "TOTAL EMPRESA");
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
