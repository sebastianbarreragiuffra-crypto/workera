import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryToReviewQueueCategory, initialsOf, currentWeekRange, getSupervisorDashboard } from "./dashboard-view";

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

// -----------------------------------------------------------------------------
// getSupervisorDashboard: verificación de scoping de área de extremo a extremo
// -- regresión directa de un bug real encontrado en esta misma fase (el
// resumen semanal/cumpleaños de un supervisor consultaban SIN scope, "null"
// = toda la empresa, filtrando información de otras áreas).

function mockSupabaseForSupervisor(scopedEmployeeId: string, foreignEmployeeId: string) {
  const employeeGroups = [
    { id: "grp-production", code: "PRODUCTION" },
    { id: "grp-installation", code: "INSTALLATION" },
  ];
  const employees = [
    { id: scopedEmployeeId, employee_group_id: "grp-production", active: true },
    { id: foreignEmployeeId, employee_group_id: "grp-installation", active: true },
  ];
  const birthdays = [
    { employee_id: scopedEmployeeId, birth_month: 8, birth_day: 20, employees: { display_name: "Empleado Producción" } },
    { employee_id: foreignEmployeeId, birth_month: 8, birth_day: 21, employees: { display_name: "Empleado Instalación" } },
  ];

  function selectBuilder(rows: unknown[], opts: { count?: number } = {}) {
    const builder: Record<string, unknown> = {
      select() {
        return builder;
      },
      eq(col: string, value: unknown) {
        filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] === value);
        return builder;
      },
      in(col: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes((r as Record<string, unknown>)[col]));
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
          return selectBuilder(employeeGroups);
        case "employees":
          return selectBuilder(employees);
        case "employee_birthdays":
          return selectBuilder(birthdays);
        case "holidays":
          return selectBuilder([]);
        case "weekly_reviews":
        case "reporting_periods":
          return selectBuilder([]);
        default:
          // late_arrival_records / overtime_records / overtime_decisions /
          // absence_records / employee_daily_bonuses / attendance_records /
          // attendance_missing_punch_flags: sin filas en este mock, pero
          // deben filtrarse por employee_id igual que las tablas reales.
          return selectBuilder([]);
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
