import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import type { Database } from "../../../src/lib/supabase/database.types";
import {
  currentIsoWeekRange,
  nextDate,
  previousDate,
  todayInSantiago,
} from "../../../src/lib/shared/date-time";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../../src/lib/shared/workforce-constants";
import {
  ARCOTEX_SHADOW_KEY_ENV,
  ARCOTEX_SHADOW_KEY_HEADER,
  ARCOTEX_SHADOW_SCENARIO_HEADER,
  type ArcotexShadowScenario,
} from "./arcotex-shadow-constants";

type FixtureRow = Record<string, unknown>;
type FixtureError = { message: string };
type FixtureResult = { data: unknown; error: FixtureError | null; count: number | null };

const USER_ID = "e2e00000-0000-4000-8000-000000000001";
const GROUP_PRODUCTION = "e2e10000-0000-4000-8000-000000000001";
const GROUP_INSTALLATION = "e2e10000-0000-4000-8000-000000000002";
const GROUP_ADMINISTRATION = "e2e10000-0000-4000-8000-000000000003";
const EMPLOYEE_PENDING = "e2e20000-0000-4000-8000-000000000001";
const EMPLOYEE_CLEAR = "e2e20000-0000-4000-8000-000000000002";
const EMPLOYEE_INSTALLATION = "e2e20000-0000-4000-8000-000000000003";
const EMPLOYEE_ADMINISTRATION = "e2e20000-0000-4000-8000-000000000004";
const WORK_SCHEDULE_ID = "e2e30000-0000-4000-8000-000000000001";

function fixtureTables(): Record<string, FixtureRow[]> {
  const today = todayInSantiago();
  const yesterday = previousDate(today);
  const tomorrow = nextDate(today);
  const week = currentIsoWeekRange(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEndDate = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0));
  const monthEnd = monthEndDate.toISOString().slice(0, 10);

  const groups = [
    { id: GROUP_PRODUCTION, code: "PRODUCTION", name: "Producción sintética" },
    { id: GROUP_INSTALLATION, code: "INSTALLATION", name: "Instalación sintética" },
    { id: GROUP_ADMINISTRATION, code: "ADMINISTRATION", name: "Administración sintética" },
  ];
  const employees = [
    {
      id: EMPLOYEE_PENDING,
      display_name: "Caso Sintético Pendiente",
      employee_group_id: GROUP_PRODUCTION,
      employee_groups: { code: "PRODUCTION" },
    },
    {
      id: EMPLOYEE_CLEAR,
      display_name: "Caso Sintético Sin Novedades",
      employee_group_id: GROUP_PRODUCTION,
      employee_groups: { code: "PRODUCTION" },
    },
    {
      id: EMPLOYEE_INSTALLATION,
      display_name: "Caso Sintético Instalación",
      employee_group_id: GROUP_INSTALLATION,
      employee_groups: { code: "INSTALLATION" },
    },
    {
      id: EMPLOYEE_ADMINISTRATION,
      display_name: "Caso Sintético Administración",
      employee_group_id: GROUP_ADMINISTRATION,
      employee_groups: { code: "ADMINISTRATION" },
    },
  ].map((employee, index) => ({
    ...employee,
    active: true,
    company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
    external_workera_id: `SYNTHETIC-${index + 1}`,
    first_name: "Caso",
    last_name: "Sintético",
    rut: null,
    hire_date: null,
    source: "E2E_FIXTURE",
    created_at: `${today}T12:00:00.000Z`,
    updated_at: `${today}T12:00:00.000Z`,
  }));

  return {
    profiles: [{
      id: USER_ID,
      active: true,
      display_name: "Usuario Sintético ARCOTEX",
      medical_license_approver: true,
      role: "ADMIN_RRHH",
      created_at: `${today}T12:00:00.000Z`,
    }],
    company_memberships: [{
      id: "e2e40000-0000-4000-8000-000000000001",
      user_id: USER_ID,
      company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
      role: "ADMIN_RRHH",
      active: true,
      companies: {
        id: ARCOTEX_WORKFORCE_COMPANY_ID,
        name: "ARCOTEX",
        slug: "arcotex",
        active: true,
        status: "ACTIVE",
        workspace_enabled: true,
      },
    }],
    company_modules: [],
    platform_memberships: [],
    employee_groups: groups.map((group) => ({
      ...group,
      company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
      active: true,
      created_at: `${today}T12:00:00.000Z`,
    })),
    employees,
    attendance_records: employees.map((employee, index) => ({
      id: `e2e60000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      employee_id: employee.id,
      work_date: today,
      is_current: true,
      actual_clock_in: `${today}T11:${index === 0 ? "15" : "00"}:00.000Z`,
      actual_clock_out: `${today}T20:00:00.000Z`,
    })),
    late_arrival_records: [{
      id: "e2e70000-0000-4000-8000-000000000001",
      employee_id: EMPLOYEE_PENDING,
      work_date: today,
      detected_minutes: 15,
      is_current: true,
      attendance_records: { is_current: true },
      late_arrival_decisions: [],
    }],
    early_departure_records: [],
    overtime_records: [],
    overtime_decisions: [],
    attendance_missing_punch_flags: [],
    absence_records: [],
    absence_decisions: [],
    employee_daily_bonuses: [],
    employee_birthdays: [],
    holidays: [{ holiday_date: tomorrow, name: "Feriado sintético", active: true }],
    weekly_reviews: [{ period_start: week.start, period_end: week.end, status: "OPEN" }],
    reporting_periods: [{
      company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
      period_start: monthStart,
      period_end: monthEnd,
      status: "OPEN",
    }],
    rule_engine_runs: [{
      id: "e2e80000-0000-4000-8000-000000000001",
      company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
      work_date: yesterday,
      started_at: `${yesterday}T10:00:00.000Z`,
      status: "SUCCEEDED",
    }],
    medical_license_approvals: [
      {
        id: "e2e90000-0000-4000-8000-000000000001",
        status: "PENDING_RRHH_APPROVAL",
        proposed_start_date: today,
        proposed_end_date: tomorrow,
        extraction_status: "EXTRAIDO",
        confirmed_start_date: null,
        confirmed_end_date: null,
        uploaded_at: `${today}T13:00:00.000Z`,
        approved_at: null,
        rejected_at: null,
        rejection_reason: null,
        supporting_document_id: "e2ea0000-0000-4000-8000-000000000001",
        absence_records: {
          employee_id: EMPLOYEE_CLEAR,
          employees: {
            display_name: "Caso Sintético Sin Novedades",
            employee_groups: { code: "PRODUCTION" },
          },
        },
        uploader: { display_name: "Usuario Sintético ARCOTEX" },
        approver: null,
        rejecter: null,
      },
      {
        id: "e2e90000-0000-4000-8000-000000000002",
        status: "APPROVED",
        proposed_start_date: yesterday,
        proposed_end_date: tomorrow,
        extraction_status: "EXTRAIDO",
        confirmed_start_date: yesterday,
        confirmed_end_date: tomorrow,
        uploaded_at: `${yesterday}T13:00:00.000Z`,
        approved_at: `${today}T12:00:00.000Z`,
        rejected_at: null,
        rejection_reason: null,
        supporting_document_id: "e2ea0000-0000-4000-8000-000000000002",
        absence_records: {
          employee_id: EMPLOYEE_INSTALLATION,
          employees: {
            display_name: "Caso Sintético Instalación",
            employee_groups: { code: "INSTALLATION" },
          },
        },
        uploader: { display_name: "Usuario Sintético ARCOTEX" },
        approver: { display_name: "Usuario Sintético ARCOTEX" },
        rejecter: null,
      },
    ],
    employee_time_control_policies: [{
      employee_id: EMPLOYEE_INSTALLATION,
      policy_code: "EXEMPT_FROM_TIME_CONTROL",
      legal_basis: "ARTICLE_22",
      effective_from: "2000-01-01",
      effective_to: null,
      employees: { company_id: ARCOTEX_WORKFORCE_COMPANY_ID },
    }],
    schedule_assignments: [
      {
        employee_id: EMPLOYEE_PENDING,
        company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
        work_schedule_id: WORK_SCHEDULE_ID,
        effective_from: "2000-01-01",
        effective_to: null,
        rrhh_confirmed_at: `${today}T12:00:00.000Z`,
        work_schedules: { name: "Horario sintético planta" },
      },
      {
        employee_id: EMPLOYEE_ADMINISTRATION,
        company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
        work_schedule_id: WORK_SCHEDULE_ID,
        effective_from: "2000-01-01",
        effective_to: null,
        rrhh_confirmed_at: `${today}T12:00:00.000Z`,
        work_schedules: { name: "Horario sintético planta" },
      },
    ],
    work_schedules: [{
      id: WORK_SCHEDULE_ID,
      company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
      name: "Horario sintético planta",
      active: true,
      work_schedule_rules: [1, 2, 3, 4, 5].map((day) => ({
        day_of_week: day,
        scheduled_start: "08:00:00",
        scheduled_end: "17:00:00",
      })),
    }],
    work_schedule_rules: [1, 2, 3, 4, 5].map((day) => ({
      work_schedule_id: WORK_SCHEDULE_ID,
      day_of_week: day,
      scheduled_start: "08:00:00",
      scheduled_end: "17:00:00",
    })),
    supporting_documents: [],
    attendance_corrections: [],
    workera_attendance_events: [],
  };
}

function valuesAtPath(value: unknown, path: string): unknown[] {
  const parts = path.split(".");
  let values: unknown[] = [value];
  for (const part of parts) {
    values = values.flatMap((item) => {
      if (Array.isArray(item)) return item.flatMap((entry) => valuesAtPath(entry, part));
      if (!item || typeof item !== "object") return [];
      return [(item as FixtureRow)[part]];
    });
  }
  return values;
}

function comparable(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

class FixtureQueryBuilder implements PromiseLike<FixtureResult> {
  private predicates: ((row: FixtureRow) => boolean)[] = [];
  private orderings: { column: string; ascending: boolean }[] = [];
  private rowLimit: number | null = null;
  private head = false;
  private wantsCount = false;

  constructor(
    private readonly table: string,
    private readonly rows: FixtureRow[],
    private readonly scenario: ArcotexShadowScenario,
  ) {}

  select(columns = "*", options?: { count?: string; head?: boolean }) {
    void columns;
    this.head = options?.head === true;
    this.wantsCount = options?.count === "exact";
    return this;
  }

  eq(column: string, expected: unknown) {
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => value === expected));
    return this;
  }

  neq(column: string, expected: unknown) {
    this.predicates.push((row) => valuesAtPath(row, column).every((value) => value !== expected));
    return this;
  }

  in(column: string, expected: readonly unknown[]) {
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => expected.includes(value)));
    return this;
  }

  is(column: string, expected: unknown) {
    return this.eq(column, expected);
  }

  not(column: string, operator: string, expected: unknown) {
    if (operator === "is") return this.neq(column, expected);
    this.predicates.push(() => false);
    return this;
  }

  gte(column: string, expected: string | number) {
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => comparable(value)! >= expected));
    return this;
  }

  lte(column: string, expected: string | number) {
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => comparable(value)! <= expected));
    return this;
  }

  gt(column: string, expected: string | number) {
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => comparable(value)! > expected));
    return this;
  }

  lt(column: string, expected: string | number) {
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => comparable(value)! < expected));
    return this;
  }

  ilike(column: string, pattern: string) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*");
    const matcher = new RegExp(`^${escaped}$`, "i");
    this.predicates.push((row) => valuesAtPath(row, column).some((value) => typeof value === "string" && matcher.test(value)));
    return this;
  }

  or(expression: string) {
    const alternatives = expression.split(",").map((part) => part.trim());
    this.predicates.push((row) => alternatives.some((part) => {
      const match = /^(.+)\.(is|eq|gte|lte)\.(.+)$/.exec(part);
      if (!match) return false;
      const [, column, operator, rawExpected] = match;
      const expected: string | null = rawExpected === "null" ? null : rawExpected;
      return valuesAtPath(row, column).some((value) => {
        if (operator === "is" || operator === "eq") return value === expected;
        if (operator === "gte") return comparable(value)! >= rawExpected;
        return comparable(value)! <= rawExpected;
      });
    }));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderings.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value: number) {
    this.rowLimit = value;
    return this;
  }

  range(from: number, to: number) {
    this.rowLimit = Math.max(0, to - from + 1);
    return this;
  }

  maybeSingle(): Promise<FixtureResult> {
    return this.execute("maybeSingle");
  }

  single(): Promise<FixtureResult> {
    return this.execute("single");
  }

  then<TResult1 = FixtureResult, TResult2 = never>(
    onfulfilled?: ((value: FixtureResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute("many").then(onfulfilled, onrejected);
  }

  private async execute(mode: "many" | "maybeSingle" | "single"): Promise<FixtureResult> {
    if (this.table === "employee_groups" && this.scenario === "slow-review") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    if (this.table === "employee_groups" && this.scenario === "review-error") {
      return { data: null, error: { message: "Fallo sintético de frontera" }, count: null };
    }

    let selected = this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));
    for (const ordering of [...this.orderings].reverse()) {
      selected = [...selected].sort((left, right) => {
        const a = comparable(valuesAtPath(left, ordering.column)[0]);
        const b = comparable(valuesAtPath(right, ordering.column)[0]);
        if (a === b) return 0;
        const direction = a === null || b === null ? 0 : a < b ? -1 : 1;
        return ordering.ascending ? direction : -direction;
      });
    }
    if (this.rowLimit !== null) selected = selected.slice(0, this.rowLimit);

    const count = this.wantsCount ? selected.length : null;
    if (this.head) return { data: null, error: null, count };
    if (mode === "maybeSingle") return { data: selected[0] ?? null, error: null, count };
    if (mode === "single") {
      return selected.length === 1
        ? { data: selected[0], error: null, count }
        : { data: null, error: { message: `Se esperaba una fila sintética en ${this.table}.` }, count };
    }
    return { data: selected, error: null, count };
  }
}

class FixtureRpcBuilder implements PromiseLike<FixtureResult> {
  constructor(private readonly result: FixtureResult) {}

  single(): Promise<FixtureResult> {
    return Promise.resolve(this.result);
  }

  then<TResult1 = FixtureResult, TResult2 = never>(
    onfulfilled?: ((value: FixtureResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function createFixtureClient(scenario: ArcotexShadowScenario): SupabaseClient<Database> {
  const tables = fixtureTables();
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: USER_ID } }, error: null };
      },
      async getClaims() {
        return { data: { claims: { sub: USER_ID, aal: "aal2" } }, error: null };
      },
    },
    from(table: string) {
      return new FixtureQueryBuilder(table, tables[table] ?? [], scenario);
    },
    rpc(name: string, args?: Record<string, unknown>) {
      if (name === "has_company_app_role") {
        return new FixtureRpcBuilder({ data: args?.p_role === "ADMIN_RRHH", error: null, count: null });
      }
      if (name === "is_medical_license_approver") {
        return new FixtureRpcBuilder({ data: true, error: null, count: null });
      }
      return new FixtureRpcBuilder({
        data: null,
        error: { message: `RPC sintético no implementado: ${name}` },
        count: null,
      });
    },
  };

  return client as unknown as SupabaseClient<Database>;
}

function isScenario(value: string | null): value is ArcotexShadowScenario {
  return value === "ready" || value === "slow-review" || value === "review-error";
}

/**
 * Frontera Supabase determinista usada por las páginas reales. No contiene
 * credenciales, RUT, correos ni nombres de personas reales.
 */
export async function createClient(): Promise<SupabaseClient<Database>> {
  const requestHeaders = await headers();
  const expectedKey = process.env[ARCOTEX_SHADOW_KEY_ENV];
  if (!expectedKey || requestHeaders.get(ARCOTEX_SHADOW_KEY_HEADER) !== expectedKey) {
    throw new Error("Solicitud fuera del harness ARCOTEX.");
  }

  const requestedScenario = requestHeaders.get(ARCOTEX_SHADOW_SCENARIO_HEADER);
  return createFixtureClient(isScenario(requestedScenario) ? requestedScenario : "ready");
}
