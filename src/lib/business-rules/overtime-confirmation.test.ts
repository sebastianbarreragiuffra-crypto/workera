import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOvertimeCandidate } from "./overtime-confirmation";

function createMockSupabase(handlers: {
  employee_time_control_policies?: () => { data: unknown; error: unknown };
  schedule_assignments?: () => { data: unknown; error: unknown };
  work_schedule_rules?: () => { data: unknown; error: unknown };
  employees?: () => { data: unknown; error: unknown };
  employee_groups?: () => { data: unknown; error: unknown };
  overtime_policies?: () => { data: unknown; error: unknown };
  overtime_records_existing?: () => { data: unknown; error: unknown };
  overtime_types?: () => { data: unknown; error: unknown };
  overtime_records_insert?: () => { data: unknown; error: unknown };
}) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let isInsert = false;
      let limitCalled = false;
      const builder = {
        select() {
          return builder;
        },
        insert() {
          isInsert = true;
          return builder;
        },
        eq() {
          return builder;
        },
        lte() {
          return builder;
        },
        or() {
          return builder;
        },
        limit() {
          limitCalled = true;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "overtime_records") return handlers.overtime_records_existing?.() ?? { data: null, error: null };
          return handlers[table as keyof typeof handlers]?.() ?? { data: null, error: null };
        },
        single: async () => {
          if (table === "employees") return handlers.employees?.() ?? { data: null, error: null };
          if (table === "employee_groups") return handlers.employee_groups?.() ?? { data: null, error: null };
          if (table === "overtime_types" && limitCalled) return handlers.overtime_types?.() ?? { data: { id: "ot-1" }, error: null };
          if (table === "overtime_records" && isInsert) return handlers.overtime_records_insert?.() ?? { data: { id: "or-mock" }, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
}

test("overtime PRODUCTION: genera candidato usando el horario efectivo (nunca 17:00 fijo)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-alejandro" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "08:30:00", scheduled_end: "18:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-1", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({ data: null, error: null }),
    overtime_records_insert: () => ({ data: { id: "or-1" }, error: null }),
  });
  // 19:00 -04 = 23:00Z, 1h después del scheduled_end 18:00 de Alejandro.
  const result = await generateOvertimeCandidate(mock as never, "alejandro-id", "2026-08-17", "att-1", "2026-08-17T23:00:00.000Z");
  assert.equal(result.status, "GENERATED");
  assert.equal(result.candidateMinutes, 60);
});

test("overtime PRODUCTION: candidato se topa en max_overtime_minutes (cap confirmado, Gate D)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-1", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({ data: null, error: null }),
    overtime_records_insert: () => ({ data: { id: "or-2" }, error: null }),
  });
  // 20:00 -04 = 3h reales tras el scheduled_end 17:00 -> topado a 120.
  const result = await generateOvertimeCandidate(mock as never, "emp-1", "2026-08-17", "att-1", "2026-08-18T00:00:00.000Z");
  assert.equal(result.candidateMinutes, 120);
});

test("overtime INSTALLATION: NUNCA genera candidato automático (PASO 36, reglas exactas pendientes)", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-install" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-installation" }, error: null }),
    employee_groups: () => ({ data: { code: "INSTALLATION" }, error: null }),
  });
  const result = await generateOvertimeCandidate(mock as never, "emp-install", "2026-08-17", "att-1", "2026-08-17T22:00:00.000Z");
  assert.equal(result.status, "OVERTIME_POLICY_REQUIRES_CONFIRMATION");
  assert.equal(result.overtimeRecordId, null);
});

test("overtime ADMINISTRATION: NOT_ELIGIBLE, nunca genera candidato", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-admin" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-admin" }, error: null }),
    employee_groups: () => ({ data: { code: "ADMINISTRATION" }, error: null }),
  });
  const result = await generateOvertimeCandidate(mock as never, "emp-admin", "2026-08-17", "att-1", "2026-08-17T22:00:00.000Z");
  assert.equal(result.status, "NOT_ELIGIBLE");
});

test("overtime: trabajador exento nunca genera candidato", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" }, error: null }),
  });
  const result = await generateOvertimeCandidate(mock as never, "michel-id", "2026-08-17", "att-1", "2026-08-17T22:00:00.000Z");
  assert.equal(result.status, "EXEMPT");
});
