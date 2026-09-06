import { test } from "node:test";
import assert from "node:assert/strict";
import { getDailyReviewDetail } from "./daily-review-view";

interface QueryCall {
  table: string;
  selected: string | null;
  filters: Array<[method: string, column: string, value: unknown]>;
}

interface MissingPunchFixture {
  status: "PENDING_CONTACT" | "CONTACTED";
  missing_type: "MISSING_CLOCK_IN" | "MISSING_CLOCK_OUT" | "MISSING_BOTH";
  attendance_records: { is_current: boolean; source: "workera" | "manual" };
}

function createDetailMock(flag: MissingPunchFixture | null, queries: QueryCall[]) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      const query: QueryCall = { table, selected: null, filters: [] };
      queries.push(query);

      const builder = {
        select(selected: string) {
          query.selected = selected;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters.push(["eq", column, value]);
          return builder;
        },
        in(column: string, value: unknown) {
          query.filters.push(["in", column, value]);
          return builder;
        },
        lte(column: string, value: unknown) {
          query.filters.push(["lte", column, value]);
          return builder;
        },
        gte(column: string, value: unknown) {
          query.filters.push(["gte", column, value]);
          return builder;
        },
        or(expression: string) {
          query.filters.push(["or", expression, null]);
          return builder;
        },
        order() {
          return builder;
        },
        single: async () => {
          if (table === "employees" && query.selected?.includes("employee_groups!")) {
            return { data: { employee_groups: { code: "PRODUCTION" } }, error: null };
          }
          if (table === "employees") {
            return { data: { id: "emp-1", display_name: "Persona de prueba" }, error: null };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          if (table === "employee_time_control_policies") return { data: null, error: null };
          if (table === "schedule_assignments") return { data: { work_schedule_id: "ws-1" }, error: null };
          if (table === "work_schedule_rules") {
            return { data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null };
          }
          if (table === "attendance_missing_punch_flags") {
            const requiresCurrentAttendance = query.filters.some(
              ([method, column, value]) => method === "eq" && column === "attendance_records.is_current" && value === true
            );
            return {
              data: flag && (!requiresCurrentAttendance || flag.attendance_records.is_current) ? flag : null,
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(onResolve: (result: { data: unknown; error: unknown }) => void) {
          return onResolve({ data: [], error: null });
        },
      };

      return builder;
    },
  };
}

test("getDailyReviewDetail: no muestra una flag ligada a attendance histórico", async () => {
  const queries: QueryCall[] = [];
  const mock = createDetailMock(
    {
      status: "PENDING_CONTACT",
      missing_type: "MISSING_CLOCK_OUT",
      attendance_records: { is_current: false, source: "workera" },
    },
    queries
  );

  const result = await getDailyReviewDetail(mock as never, "SUPER_ADMIN", "emp-1", "2026-08-17");

  assert.equal(result.missingPunch, null);
  const flagQuery = queries.find((query) => query.table === "attendance_missing_punch_flags");
  assert.match(flagQuery?.selected ?? "", /attendance_records!inner\(is_current\)/);
  assert.ok(
    flagQuery?.filters.some(
      ([method, column, value]) => method === "eq" && column === "attendance_records.is_current" && value === true
    )
  );
});

test("getDailyReviewDetail: conserva una flag ligada a attendance manual vigente", async () => {
  const queries: QueryCall[] = [];
  const mock = createDetailMock(
    {
      status: "CONTACTED",
      missing_type: "MISSING_CLOCK_IN",
      attendance_records: { is_current: true, source: "manual" },
    },
    queries
  );

  const result = await getDailyReviewDetail(mock as never, "SUPER_ADMIN", "emp-1", "2026-08-17");

  assert.equal(result.missingPunch, "MISSING_CLOCK_IN");
  const flagQuery = queries.find((query) => query.table === "attendance_missing_punch_flags");
  assert.equal(flagQuery?.filters.some(([, column]) => column === "attendance_records.source"), false);
});
