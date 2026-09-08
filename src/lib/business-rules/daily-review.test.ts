import { test } from "node:test";
import assert from "node:assert/strict";
import { getDailyReview, DailyReviewAuthorizationError } from "./daily-review";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../shared/workforce-constants";

function createMockSupabase() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(): any {
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        in() {
          return builder;
        },
        single: async () => ({ data: { id: "grp-1" }, error: null }),
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          onResolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
}

test("getDailyReview: SUPERVISOR_PRODUCTION pidiendo INSTALLATION -> DENIED (scoping aplicado en el servicio, no solo RLS)", async () => {
  await assert.rejects(
    () => getDailyReview(createMockSupabase() as never, "SUPERVISOR_PRODUCTION", "INSTALLATION", "2026-08-17"),
    DailyReviewAuthorizationError
  );
});

test("getDailyReview: SUPERVISOR_INSTALLATION pidiendo PRODUCTION -> DENIED", async () => {
  await assert.rejects(
    () => getDailyReview(createMockSupabase() as never, "SUPERVISOR_INSTALLATION", "PRODUCTION", "2026-08-17"),
    DailyReviewAuthorizationError
  );
});

test("getDailyReview: SUPERVISOR_PRODUCTION pidiendo su propia área -> ALLOWED", async () => {
  const result = await getDailyReview(createMockSupabase() as never, "SUPERVISOR_PRODUCTION", "PRODUCTION", "2026-08-17");
  assert.equal(result.groupCode, "PRODUCTION");
});

test("getDailyReview: SUPER_ADMIN puede pedir cualquier área", async () => {
  await getDailyReview(createMockSupabase() as never, "SUPER_ADMIN", "INSTALLATION", "2026-08-17");
  await getDailyReview(createMockSupabase() as never, "SUPER_ADMIN", "ADMINISTRATION", "2026-08-17");
});

test("getDailyReview: ADMIN_RRHH puede pedir cualquier área", async () => {
  await getDailyReview(createMockSupabase() as never, "ADMIN_RRHH", "PRODUCTION", "2026-08-17");
  await getDailyReview(createMockSupabase() as never, "ADMIN_RRHH", "ADMINISTRATION", "2026-08-17");
});

test("getDailyReview: sin trabajadores en el área -> listas vacías, no lanza", async () => {
  const result = await getDailyReview(createMockSupabase() as never, "SUPER_ADMIN", "PRODUCTION", "2026-08-17");
  assert.deepEqual(result.requiresReview, []);
  assert.deepEqual(result.noIssues, []);
});

test("getDailyReview: la empresa activa filtra tanto el área como sus trabajadores", async () => {
  const filters: Array<[string, string, unknown]> = [];
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          filters.push([table, column, value]);
          return builder;
        },
        single: async () => ({ data: { id: "group-a" }, error: null }),
        then(resolve: (value: { data: unknown[]; error: null }) => void) {
          resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };

  await getDailyReview(client as never, "ADMIN_RRHH", "PRODUCTION", "2026-08-17", "company-a");
  assert.ok(filters.some((entry) => entry[0] === "employee_groups" && entry[1] === "company_id" && entry[2] === "company-a"));
  assert.ok(filters.some((entry) => entry[0] === "employees" && entry[1] === "company_id" && entry[2] === "company-a"));
});

function createMissingPunchReconciliationMock() {
  const selectedRelations: string[] = [];
  const rowsByTable: Record<string, Record<string, unknown>[]> = {
    employee_groups: [{ id: "grp-production", code: "PRODUCTION" }],
    employees: [
      { id: "emp-current", display_name: "Manual vigente", employee_group_id: "grp-production", active: true },
      { id: "emp-stale", display_name: "Reconciliado", employee_group_id: "grp-production", active: true },
    ],
    attendance_missing_punch_flags: [
      {
        employee_id: "emp-current",
        work_date: "2026-08-17",
        status: "PENDING_CONTACT",
        attendance_records: { is_current: true, source: "manual" },
      },
      {
        employee_id: "emp-stale",
        work_date: "2026-08-17",
        status: "PENDING_CONTACT",
        attendance_records: { is_current: false, source: "workera" },
      },
    ],
  };

  const valueAt = (row: Record<string, unknown>, path: string): unknown =>
    path.split(".").reduce<unknown>((value, segment) => {
      if (!value || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[segment];
    }, row);

  return {
    selectedRelations,
    client: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from(table: string): any {
        let filtered = [...(rowsByTable[table] ?? [])];
        const builder = {
          select(columns: string) {
            if (table === "attendance_missing_punch_flags") selectedRelations.push(columns);
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
          lte() {
            return builder;
          },
          gte() {
            return builder;
          },
          single: async () => ({ data: filtered[0] ?? null, error: null }),
          then(onResolve: (result: { data: Record<string, unknown>[]; error: null }) => void) {
            onResolve({ data: filtered, error: null });
          },
        };
        return builder;
      },
    },
  };
}

test("getDailyReview: oculta una flag reconciliada y conserva una flag manual vigente", async () => {
  const { client, selectedRelations } = createMissingPunchReconciliationMock();
  const result = await getDailyReview(client as never, "SUPER_ADMIN", "PRODUCTION", "2026-08-17");

  assert.deepEqual(result.requiresReview.map((row) => row.employeeId), ["emp-current"]);
  assert.deepEqual(result.noIssues.map((row) => row.employeeId), ["emp-stale"]);
  assert.ok(
    selectedRelations.some((selection) => selection.includes("attendance_records!inner(is_current)")),
    "la consulta debe exigir el attendance_record vigente mediante inner join"
  );
});

test("getDailyReview: 43 personas de HOLDING bajo el mismo company_id quedan fuera del padrón ARCOTEX", async () => {
  const authorizedIds = Array.from(
    { length: 45 },
    (_, index) => `a7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const holdingIds = Array.from(
    { length: 43 },
    (_, index) => `b7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const previousRoster = process.env.ARCOTEX_PILOT_EMPLOYEE_IDS;
  process.env.ARCOTEX_PILOT_EMPLOYEE_IDS = authorizedIds.join(",");

  const rowsByTable: Record<string, Record<string, unknown>[]> = {
    employee_groups: [{ id: "grp-production", code: "PRODUCTION", company_id: ARCOTEX_WORKFORCE_COMPANY_ID }],
    employees: [
      {
        id: authorizedIds[0],
        display_name: "Persona ARCOTEX",
        employee_group_id: "grp-production",
        company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
        active: true,
      },
      ...holdingIds.map((id, index) => ({
        id,
        display_name: `Persona HOLDING ${index + 1}`,
        employee_group_id: "grp-production",
        company_id: ARCOTEX_WORKFORCE_COMPANY_ID,
        active: true,
      })),
    ],
  };
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let rows = [...(rowsByTable[table] ?? [])];
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        lte() { return builder; },
        gte() { return builder; },
        single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: "sin fila" } }),
        then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => void) {
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };

  try {
    const result = await getDailyReview(
      client as never,
      "ADMIN_RRHH",
      "PRODUCTION",
      "2026-08-24",
      ARCOTEX_WORKFORCE_COMPANY_ID,
    );
    assert.deepEqual(result.requiresReview, []);
    assert.deepEqual(result.noIssues.map((employee) => employee.employeeId), [authorizedIds[0]]);
    assert.equal(
      result.noIssues.some((employee) => holdingIds.includes(employee.employeeId)),
      false,
    );
  } finally {
    if (previousRoster === undefined) delete process.env.ARCOTEX_PILOT_EMPLOYEE_IDS;
    else process.env.ARCOTEX_PILOT_EMPLOYEE_IDS = previousRoster;
  }
});
