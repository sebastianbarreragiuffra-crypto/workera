import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOvertimeCandidate as generateOvertimeCandidateRaw } from "./overtime-confirmation";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";
const RUN_ID = "30000000-0000-4000-8000-000000000003";

const generateOvertimeCandidate = (
  supabase: Parameters<typeof generateOvertimeCandidateRaw>[0],
  employeeId: string,
  workDate: string,
  attendanceRecordId: string,
  clockOut: string | null,
  clockIn: string | null = null,
  isHoliday = false
) => generateOvertimeCandidateRaw(
  supabase,
  employeeId,
  workDate,
  attendanceRecordId,
  clockOut,
  clockIn,
  isHoliday,
  COMPANY_ID,
  RUN_ID
);

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
  overtime_records_update?: (id: string | null) => { data: unknown; error: unknown };
}) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "reconcile_overtime_candidate");
      const existingResult = handlers.overtime_records_existing?.() ?? { data: null, error: null };
      if (existingResult.error) return { data: null, error: existingResult.error };
      const existing = existingResult.data as {
        id: string;
        attendance_record_id?: string;
        candidate_minutes?: number;
        overtime_policy_id?: string;
        overtime_types?: { code: string } | null;
      } | null;

      if (args.p_attendance_record_id === null) {
        if (existing) {
          const update = handlers.overtime_records_update?.(existing.id) ?? { data: null, error: null };
          if (update.error) return { data: null, error: update.error };
        }
        return { data: { record_id: null, changed: existing !== null }, error: null };
      }

      const date = String(args.p_work_date);
      const expectedType = date === "2026-09-18" || new Date(`${date}T00:00:00Z`).getUTCDay() === 0
        ? "OVERTIME_100"
        : "OVERTIME_50";
      if (
        existing &&
        existing.attendance_record_id === args.p_attendance_record_id &&
        existing.candidate_minutes === args.p_candidate_minutes &&
        existing.overtime_policy_id === args.p_overtime_policy_id &&
        existing.overtime_types?.code === expectedType
      ) {
        return { data: { record_id: existing.id, changed: false }, error: null };
      }
      if (existing) {
        const update = handlers.overtime_records_update?.(existing.id) ?? { data: null, error: null };
        if (update.error) return { data: null, error: update.error };
      }
      const inserted = handlers.overtime_records_insert?.() ?? { data: { id: "or-mock" }, error: null };
      if (inserted.error) return { data: null, error: inserted.error };
      return {
        data: { record_id: (inserted.data as { id: string }).id, changed: true },
        error: null,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let isInsert = false;
      let isUpdate = false;
      let limitCalled = false;
      let updatedId: string | null = null;
      const builder = {
        select() {
          return builder;
        },
        insert() {
          isInsert = true;
          return builder;
        },
        update() {
          isUpdate = true;
          return builder;
        },
        eq(column: string, value: unknown) {
          if (isUpdate && column === "id") updatedId = String(value);
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
          if (table === "employee_group_assignments") {
            const employee = handlers.employees?.() ?? { data: null, error: null };
            const group = handlers.employee_groups?.() ?? { data: null, error: null };
            const employeeRow = employee.data as { employee_group_id?: string } | null;
            return employeeRow?.employee_group_id && group.data
              ? {
                  data: { employee_group_id: employeeRow.employee_group_id, employee_groups: group.data },
                  error: employee.error ?? group.error,
                }
              : { data: null, error: employee.error ?? group.error };
          }
          if (table === "overtime_records") return handlers.overtime_records_existing?.() ?? { data: null, error: null };
          const readHandler = handlers[table as keyof typeof handlers] as
            | (() => { data: unknown; error: unknown })
            | undefined;
          return readHandler?.() ?? { data: null, error: null };
        },
        single: async () => {
          if (table === "employees") return handlers.employees?.() ?? { data: null, error: null };
          if (table === "employee_groups") return handlers.employee_groups?.() ?? { data: null, error: null };
          if (table === "overtime_types" && limitCalled) return handlers.overtime_types?.() ?? { data: { id: "ot-1" }, error: null };
          if (table === "overtime_records" && isInsert) return handlers.overtime_records_insert?.() ?? { data: { id: "or-mock" }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => void) => {
          if (table === "overtime_records" && isUpdate) {
            resolve(handlers.overtime_records_update?.(updatedId) ?? { data: null, error: null });
            return;
          }
          resolve({ data: null, error: null });
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

test("overtime PRODUCTION: candidato conserva horas reales aunque exceda el tope pagable", async () => {
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
  assert.equal(result.candidateMinutes, 180);
});

test("overtime INSTALLATION: genera minutos exactos, sin selector 1h/2h", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-install" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-installation" }, error: null }),
    employee_groups: () => ({ data: { code: "INSTALLATION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-install", overtime_eligible: true, max_overtime_minutes: 1440 }, error: null }),
    overtime_records_existing: () => ({ data: null, error: null }),
    overtime_records_insert: () => ({ data: { id: "or-install" }, error: null }),
  });
  // 18:05 en Santiago: 65 minutos exactos después de la salida de las 17:00.
  const result = await generateOvertimeCandidate(mock as never, "emp-install", "2026-08-17", "att-1", "2026-08-17T22:05:00.000Z");
  assert.equal(result.status, "GENERATED");
  assert.equal(result.candidateMinutes, 65);
});

test("overtime INSTALLATION: en día libre usa el tramo real entrada-salida", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-install" }, error: null }),
    work_schedule_rules: () => ({ data: null, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-installation" }, error: null }),
    employee_groups: () => ({ data: { code: "INSTALLATION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-install", overtime_eligible: true, max_overtime_minutes: 1440 }, error: null }),
    overtime_records_existing: () => ({ data: null, error: null }),
    overtime_records_insert: () => ({ data: { id: "or-install-weekend" }, error: null }),
  });
  const result = await generateOvertimeCandidate(
    mock as never,
    "emp-install",
    "2026-08-22",
    "att-weekend",
    "2026-08-22T18:10:00.000Z",
    "2026-08-22T14:00:00.000Z"
  );
  assert.equal(result.status, "GENERATED");
  assert.equal(result.candidateMinutes, 250);
});

test("overtime PRODUCTION: un feriado conserva todo el tramo real; el pago se topa después", async () => {
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-production" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-weekday", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({ data: null, error: null }),
    overtime_records_insert: () => ({ data: { id: "or-holiday" }, error: null }),
  });
  const result = await generateOvertimeCandidate(
    mock as never,
    "emp-prod",
    "2026-09-18",
    "att-holiday",
    "2026-09-18T21:00:00.000Z",
    "2026-09-18T12:00:00.000Z",
    true
  );
  assert.equal(result.status, "GENERATED");
  assert.equal(result.candidateMinutes, 540);
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

test("overtime: si el recálculo queda en cero retira el candidato vigente", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-1", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({ data: { id: "or-vigente", candidate_minutes: 60, calculation_version: 1 }, error: null }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
  });

  // 17:00 de Santiago: ya no existe tiempo posterior al horario efectivo.
  const result = await generateOvertimeCandidate(mock as never, "emp-1", "2026-08-17", "att-1", "2026-08-17T21:00:00.000Z");

  assert.equal(result.status, "NO_OVERTIME");
  assert.deepEqual(retired, ["or-vigente"]);
});

test("overtime: perder la salida retira el candidato vigente", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    overtime_records_existing: () => ({ data: { id: "or-sin-salida", candidate_minutes: 60, calculation_version: 1 }, error: null }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
  });

  const result = await generateOvertimeCandidate(mock as never, "emp-1", "2026-08-17", "att-1", null);

  assert.equal(result.status, "NO_CLOCK_OUT");
  assert.deepEqual(retired, ["or-sin-salida"]);
});

test("overtime: quedar exento retira el candidato vigente", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: { policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" }, error: null }),
    overtime_records_existing: () => ({ data: { id: "or-exento", candidate_minutes: 60, calculation_version: 1 }, error: null }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
  });

  const result = await generateOvertimeCandidate(mock as never, "emp-1", "2026-08-17", "att-1", "2026-08-17T22:00:00.000Z");

  assert.equal(result.status, "EXEMPT");
  assert.deepEqual(retired, ["or-exento"]);
});

test("overtime: quedar no elegible retira el candidato vigente", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-admin" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-admin" }, error: null }),
    employee_groups: () => ({ data: { code: "ADMINISTRATION" }, error: null }),
    overtime_records_existing: () => ({ data: { id: "or-no-elegible", candidate_minutes: 60, calculation_version: 1 }, error: null }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
  });

  const result = await generateOvertimeCandidate(mock as never, "emp-admin", "2026-08-17", "att-1", "2026-08-17T22:00:00.000Z");

  assert.equal(result.status, "NOT_ELIGIBLE");
  assert.deepEqual(retired, ["or-no-elegible"]);
});

test("overtime: UNCHANGED exige mismo padre, política, tasa y minutos", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-1", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({
      data: {
        id: "or-vigente",
        attendance_record_id: "att-1",
        candidate_minutes: 60,
        overtime_policy_id: "pol-1",
        overtime_types: { code: "OVERTIME_50" },
        calculation_version: 1,
      },
      error: null,
    }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
  });

  const result = await generateOvertimeCandidate(
    mock as never,
    "emp-1",
    "2026-08-17",
    "att-1",
    "2026-08-17T22:00:00.000Z"
  );

  assert.equal(result.status, "UNCHANGED");
  assert.deepEqual(retired, []);
});

test("overtime: mismos minutos con otra asistencia regeneran el candidato", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-1", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({
      data: {
        id: "or-anterior",
        attendance_record_id: "att-anterior",
        candidate_minutes: 60,
        overtime_policy_id: "pol-1",
        overtime_types: { code: "OVERTIME_50" },
        calculation_version: 4,
      },
      error: null,
    }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
    overtime_records_insert: () => ({ data: { id: "or-nuevo" }, error: null }),
  });

  const result = await generateOvertimeCandidate(
    mock as never,
    "emp-1",
    "2026-08-17",
    "att-nueva",
    "2026-08-17T22:00:00.000Z"
  );

  assert.equal(result.status, "GENERATED");
  assert.deepEqual(retired, ["or-anterior"]);
});

test("overtime: un feriado reclasifica HH50 anterior aunque conserve los minutos", async () => {
  const retired: string[] = [];
  const mock = createMockSupabase({
    employee_time_control_policies: () => ({ data: null, error: null }),
    schedule_assignments: () => ({ data: { work_schedule_id: "ws-general" }, error: null }),
    work_schedule_rules: () => ({ data: { scheduled_start: "07:30:00", scheduled_end: "17:00:00" }, error: null }),
    employees: () => ({ data: { employee_group_id: "grp-production" }, error: null }),
    employee_groups: () => ({ data: { code: "PRODUCTION" }, error: null }),
    overtime_policies: () => ({ data: { id: "pol-1", overtime_eligible: true, max_overtime_minutes: 120 }, error: null }),
    overtime_records_existing: () => ({
      data: {
        id: "or-hh50",
        attendance_record_id: "att-1",
        candidate_minutes: 60,
        overtime_policy_id: "pol-1",
        overtime_types: { code: "OVERTIME_50" },
        calculation_version: 1,
      },
      error: null,
    }),
    overtime_records_update: (id) => {
      if (id) retired.push(id);
      return { data: null, error: null };
    },
    overtime_records_insert: () => ({ data: { id: "or-hh100" }, error: null }),
  });

  const result = await generateOvertimeCandidate(
    mock as never,
    "emp-1",
    "2026-09-18",
    "att-1",
    "2026-09-18T13:00:00.000Z",
    "2026-09-18T12:00:00.000Z",
    true
  );

  assert.equal(result.status, "GENERATED");
  assert.equal(result.candidateMinutes, 60);
  assert.deepEqual(retired, ["or-hh50"]);
});
