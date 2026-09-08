import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryToReviewQueueCategory, initialsOf, currentWeekRange, getSupervisorDashboard, getWeekSummary } from "./dashboard-view";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../shared/workforce-constants";

test("categoryToReviewQueueCategory: mapea las 7 categorías de getDailyReview sin inventar ninguna nueva", () => {
  assert.equal(categoryToReviewQueueCategory("LATE"), "LATE");
  assert.equal(categoryToReviewQueueCategory("OVERTIME_CANDIDATE"), "OVERTIME");
  assert.equal(categoryToReviewQueueCategory("MISSING_PUNCH"), "CLOCK_OUT");
  assert.equal(categoryToReviewQueueCategory("ABSENCE"), "LICENSE");
  assert.equal(categoryToReviewQueueCategory("LICENSE_DOCUMENT_REQUIRED"), "DOCUMENT");
  assert.equal(categoryToReviewQueueCategory("MEDICAL_DOCUMENT_REQUIRED"), "DOCUMENT");
});

test("initialsOf: primera letra del nombre + primera letra del último apellido", () => {
  assert.equal(initialsOf("María Araya"), "MA");
  assert.equal(initialsOf("Juan Carlos Herrera Soto"), "JS");
  assert.equal(initialsOf("Cher"), "C");
  assert.equal(initialsOf("  Ana   Torres  "), "AT");
});

test("currentWeekRange: lunes-domingo ISO para un miércoles", () => {
  const range = currentWeekRange("2026-08-19"); // miércoles
  assert.equal(range.start, "2026-08-17"); // lunes
  assert.equal(range.end, "2026-08-23"); // domingo
});

test("currentWeekRange: un domingo pertenece a la semana que TERMINA ese día, no a la siguiente", () => {
  const range = currentWeekRange("2026-08-23"); // domingo
  assert.equal(range.start, "2026-08-17");
  assert.equal(range.end, "2026-08-23");
});

test("currentWeekRange: cruza límite de mes correctamente", () => {
  const range = currentWeekRange("2026-09-01"); // martes
  assert.equal(range.start, "2026-08-31");
  assert.equal(range.end, "2026-09-06");
});

test("getWeekSummary: ignora aprobación y bono si el candidato o su asistencia raíz ya son históricos", async () => {
  const overtimeSelections: string[] = [];
  const bonusSelections: string[] = [];
  const valueAt = (row: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((value, segment) => {
      if (!value || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[segment];
    }, row);

  const rowsByTable: Record<string, unknown[]> = {
    late_arrival_records: [],
    absence_records: [],
    overtime_decisions: [
      {
        approved_minutes: 60,
        is_current: true,
        decision_status: "FULLY_APPROVED",
        overtime_records: {
          work_date: "2026-08-19",
          employee_id: "emp-1",
          is_current: true,
          attendance_records: { is_current: true },
        },
      },
      {
        approved_minutes: 120,
        is_current: true,
        decision_status: "FULLY_APPROVED",
        overtime_records: {
          work_date: "2026-08-19",
          employee_id: "emp-1",
          is_current: true,
          attendance_records: { is_current: false },
        },
      },
      {
        approved_minutes: 30,
        is_current: true,
        decision_status: "FULLY_APPROVED",
        overtime_records: {
          work_date: "2026-08-19",
          employee_id: "emp-1",
          is_current: false,
          attendance_records: { is_current: true },
        },
      },
    ],
    employee_daily_bonuses: [
      {
        employee_id: "emp-1",
        work_date: "2026-08-19",
        overtime_decisions: {
          is_current: true,
          overtime_records: { is_current: true, attendance_records: { is_current: true } },
        },
      },
      {
        employee_id: "emp-1",
        work_date: "2026-08-19",
        overtime_decisions: {
          is_current: true,
          overtime_records: { is_current: true, attendance_records: { is_current: false } },
        },
      },
      {
        employee_id: "emp-1",
        work_date: "2026-08-19",
        overtime_decisions: {
          is_current: true,
          overtime_records: { is_current: false, attendance_records: { is_current: true } },
        },
      },
    ],
  };

  const supabase = {
    from(table: string) {
      let filtered = [...(rowsByTable[table] ?? [])];
      const builder = {
        select(columns: string) {
          if (table === "overtime_decisions") overtimeSelections.push(columns);
          if (table === "employee_daily_bonuses") bonusSelections.push(columns);
          return builder;
        },
        eq(column: string, value: unknown) {
          filtered = filtered.filter((row) => valueAt(row, column) === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filtered = filtered.filter((row) => values.includes(valueAt(row, column)));
          return builder;
        },
        gte(column: string, value: string) {
          filtered = filtered.filter((row) => String(valueAt(row, column)) >= value);
          return builder;
        },
        lte(column: string, value: string) {
          filtered = filtered.filter((row) => String(valueAt(row, column)) <= value);
          return builder;
        },
        then(onResolve: (result: { data: unknown[]; error: null }) => void) {
          return onResolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const summary = await getWeekSummary(supabase, ["emp-1"], "2026-08-19");

  assert.equal(summary.overtimeApprovedMinutes, 60);
  assert.equal(summary.bonusesGrantedCount, 1);
  assert.ok(overtimeSelections.some((selection) => selection.includes("overtime_records!inner")));
  assert.ok(overtimeSelections.some((selection) => selection.includes("attendance_records!inner(is_current)")));
  assert.ok(bonusSelections.some((selection) => selection.includes("attendance_records!inner(is_current)")));
});

// -----------------------------------------------------------------------------
// getSupervisorDashboard: verificación de scoping de área de extremo a extremo
// -- regresión directa de un bug real encontrado en esta misma fase (el
// resumen semanal/cumpleaños de un supervisor consultaban SIN scope, "null"
// = toda la empresa, filtrando información de otras áreas).

function mockSupabaseForSupervisor(
  scopedEmployeeId: string,
  foreignEmployeeId: string,
  options: {
    missingPunchFlags?: Record<string, unknown>[];
    missingPunchSelections?: string[];
    companyId?: string;
    employees?: Record<string, unknown>[];
    birthdays?: Record<string, unknown>[];
  } = {}
) {
  const companyId = options.companyId ?? "tenant-dashboard-test";
  const employeeGroups = [
    { id: "grp-production", code: "PRODUCTION", company_id: companyId },
    { id: "grp-installation", code: "INSTALLATION", company_id: companyId },
  ];
  const employees = options.employees ?? [
    {
      id: scopedEmployeeId,
      display_name: "Empleado Producción",
      employee_group_id: "grp-production",
      active: true,
      company_id: companyId,
    },
    {
      id: foreignEmployeeId,
      display_name: "Empleado Instalación",
      employee_group_id: "grp-installation",
      active: true,
      company_id: companyId,
    },
  ];
  const birthdays = options.birthdays ?? [
    { employee_id: scopedEmployeeId, birth_month: 8, birth_day: 20, employees: { display_name: "Empleado Producción" } },
    { employee_id: foreignEmployeeId, birth_month: 8, birth_day: 21, employees: { display_name: "Empleado Instalación" } },
  ];

  const valueAt = (row: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((value, segment) => {
      if (!value || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[segment];
    }, row);

  function selectBuilder(table: string, rows: unknown[], opts: { count?: number } = {}) {
    const builder: Record<string, unknown> = {
      select(columns: string) {
        if (table === "attendance_missing_punch_flags") options.missingPunchSelections?.push(columns);
        return builder;
      },
      eq(col: string, value: unknown) {
        filtered = filtered.filter((row) => valueAt(row, col) === value);
        return builder;
      },
      in(col: string, values: unknown[]) {
        filtered = filtered.filter((row) => values.includes(valueAt(row, col)));
        return builder;
      },
      gte() {
        return builder;
      },
      lte() {
        return builder;
      },
      not() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } });
      },
      then(onResolve: (r: { data: unknown; error: null; count: number | null }) => void) {
        onResolve({ data: filtered, error: null, count: opts.count ?? filtered.length });
      },
    };
    let filtered = rows;
    return builder;
  }

  return {
    from(table: string) {
      switch (table) {
        case "employee_groups":
          return selectBuilder(table, employeeGroups);
        case "employees":
          return selectBuilder(table, employees);
        case "employee_birthdays":
          return selectBuilder(table, birthdays);
        case "holidays":
          return selectBuilder(table, []);
        case "weekly_reviews":
        case "reporting_periods":
          return selectBuilder(table, []);
        case "attendance_missing_punch_flags":
          return selectBuilder(table, options.missingPunchFlags ?? []);
        default:
          // late_arrival_records / overtime_records / overtime_decisions /
          // absence_records / employee_daily_bonuses / attendance_records /
          // sin filas en este mock, pero deben filtrarse por employee_id igual
          // que las tablas reales.
          return selectBuilder(table, []);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("getSupervisorDashboard: los cumpleaños del resumen NUNCA incluyen empleados de otra área", async () => {
  const supabase = mockSupabaseForSupervisor("emp-production-1", "emp-installation-1");
  const dashboard = await getSupervisorDashboard(supabase, "SUPERVISOR_PRODUCTION", "2026-08-19");

  assert.equal(dashboard.upcomingEvents.birthdaysThisMonth.length, 1);
  assert.equal(dashboard.upcomingEvents.birthdaysThisMonth[0].employeeId, "emp-production-1");
});

test("getSupervisorDashboard: workersActive cuenta solo empleados del área del supervisor", async () => {
  const supabase = mockSupabaseForSupervisor("emp-production-1", "emp-installation-1");
  const dashboard = await getSupervisorDashboard(supabase, "SUPERVISOR_PRODUCTION", "2026-08-19");

  assert.equal(dashboard.kpis.workersActive, 1);
});

test("getSupervisorDashboard: ARCOTEX excluye 43 fichas HOLDING de KPIs y eventos", async () => {
  const authorizedIds = Array.from({ length: 45 }, (_, index) => `authorized-${index + 1}`);
  const holdingIds = Array.from({ length: 43 }, (_, index) => `holding-${index + 1}`);
  const employees = [...authorizedIds, ...holdingIds].map((id) => ({
    id,
    display_name: id.startsWith("authorized-") ? "Persona autorizada" : "Persona HOLDING",
    employee_group_id: "grp-production",
    active: true,
    company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
  }));
  const supabase = mockSupabaseForSupervisor(authorizedIds[0], holdingIds[0], {
    companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
    employees,
    missingPunchFlags: holdingIds.map((employeeId) => ({
      employee_id: employeeId,
      work_date: "2026-08-19",
      status: "PENDING_CONTACT",
      attendance_records: { is_current: true },
    })),
    birthdays: [
      { employee_id: authorizedIds[0], birth_month: 8, birth_day: 20, employees: { display_name: "Persona autorizada" } },
      { employee_id: holdingIds[0], birth_month: 8, birth_day: 21, employees: { display_name: "Persona HOLDING" } },
    ],
  });

  const dashboard = await getSupervisorDashboard(
    supabase,
    "SUPERVISOR_PRODUCTION",
    "2026-08-19",
    ARCOTEX_WORKFORCE_COMPANY_ID,
    {
      resolveAuthorizedEmployeeScope: async () => ({
        employeeIds: authorizedIds,
        employees: authorizedIds.map((id, index) => ({ id, externalWorkeraId: `AUTHORIZED-${index + 1}` })),
      }),
    },
  );

  assert.equal(dashboard.kpis.workersActive, 45);
  assert.equal(dashboard.kpis.clockOutPending, 0);
  assert.deepEqual(dashboard.upcomingEvents.birthdaysThisMonth.map((entry) => entry.employeeId), [authorizedIds[0]]);
  assert.ok(dashboard.reviewQueue.every((entry) => !holdingIds.includes(entry.employeeId)));
});

test("getSupervisorDashboard: ARCOTEX falla cerrado antes de consultar si el padrón no se valida", async () => {
  let tableReads = 0;
  const supabase = {
    from() {
      tableReads += 1;
      throw new Error("no debe consultar tablas");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await assert.rejects(
    getSupervisorDashboard(
      supabase,
      "SUPERVISOR_PRODUCTION",
      "2026-08-19",
      ARCOTEX_WORKFORCE_COMPANY_ID,
      {
        resolveAuthorizedEmployeeScope: async () => {
          throw new Error("padrón inválido");
        },
      },
    ),
    /padrón inválido/,
  );
  assert.equal(tableReads, 0);
});

test("getSupervisorDashboard: clockOutPending ignora la flag histórica de una asistencia reconciliada", async () => {
  const missingPunchSelections: string[] = [];
  const supabase = mockSupabaseForSupervisor("emp-production-1", "emp-installation-1", {
    missingPunchSelections,
    missingPunchFlags: [
      {
        id: "flag-current",
        employee_id: "emp-production-1",
        work_date: "2026-08-19",
        status: "PENDING_CONTACT",
        attendance_records: { is_current: true },
      },
      {
        id: "flag-stale",
        employee_id: "emp-production-1",
        work_date: "2026-08-19",
        status: "PENDING_CONTACT",
        attendance_records: { is_current: false },
      },
    ],
  });

  const dashboard = await getSupervisorDashboard(supabase, "SUPERVISOR_PRODUCTION", "2026-08-19");

  assert.equal(dashboard.kpis.clockOutPending, 1);
  assert.ok(
    missingPunchSelections.some((selection) => selection.includes("id, attendance_records!inner(is_current)")),
    "el KPI debe resolver la vigencia mediante inner join con attendance_records"
  );
});
