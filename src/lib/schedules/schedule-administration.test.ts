import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  summarizeScheduleRules,
  buildScheduleAdminRows,
  type RawEmployeeRow,
  type RawAssignmentRow,
  type RawPolicyRow,
} from "./schedule-administration";

const SCHEDULE_ACTIONS_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "app",
  "(app)",
  "configuracion",
  "horarios",
  "actions.ts"
);
const SCHEDULE_PAGE_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "app",
  "(app)",
  "configuracion",
  "horarios",
  "page.tsx"
);
const SCHEDULE_ADMINISTRATION_PATH = path.resolve(import.meta.dirname, "schedule-administration.ts");
const KNOWN_SCHEDULE_SEED_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "business-rules",
  "seed-known-schedules.ts"
);
const SCHEDULE_TENANT_MIGRATION_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
  "20260906170000_schedule_tenant_versioning.sql"
);

test("la aplicación reserva toda mutación de horarios para ADMIN_RRHH y deja SUPER_ADMIN en solo lectura", () => {
  const actions = readFileSync(SCHEDULE_ACTIONS_PATH, "utf8");
  const page = readFileSync(SCHEDULE_PAGE_PATH, "utf8");
  const gateStart = actions.indexOf("async function requireScheduleAdmin");
  assert.ok(gateStart >= 0, "debe existir un gate único para las mutaciones de horarios");
  const gate = actions.slice(gateStart, gateStart + 750);
  assert.match(gate, /resolvePayrollCompanyRole\([\s\S]*?\["ADMIN_RRHH"\]/);
  assert.match(gate, /payrollRole !== "ADMIN_RRHH"/);
  assert.doesNotMatch(gate, /profile\.role !== "ADMIN_RRHH"/);
  assert.match(page, /resolvePayrollCompanyRole\([\s\S]*?\["ADMIN_RRHH", "SUPER_ADMIN"\]/);
  assert.match(page, /const canManageSchedules = payrollRole === "ADMIN_RRHH"/);
  assert.match(page, /canManage=\{canManageSchedules\}/);
  assert.match(page, /solo lectura para SUPER_ADMIN/);
});

test("el tablero y la creación de horarios exigen el companyId laboral explícito", () => {
  const administration = readFileSync(SCHEDULE_ADMINISTRATION_PATH, "utf8");
  const actions = readFileSync(SCHEDULE_ACTIONS_PATH, "utf8");
  const page = readFileSync(SCHEDULE_PAGE_PATH, "utf8");

  assert.match(administration, /getScheduleAdminBoard\([\s\S]*companyId: string/);
  assert.ok(
    (administration.match(/\.eq\("company_id", companyId\)/g) ?? []).length >= 3,
    "empleados, asignaciones y definiciones deben filtrarse por la empresa solicitada"
  );
  assert.match(administration, /\.eq\("employees\.company_id", companyId\)/);
  assert.match(administration, /p_company_id: params\.companyId/);
  assert.match(actions, /companyId: workforceCompany\.companyId|companyId,/);
  assert.match(actions, /resolveActiveWorkforceCompany\(supabase\)/);
  assert.match(page, /getScheduleAdminBoard\(supabase, today, workforceCompany\.companyId\)/);
});

test("la migración vuelve tenant-aware e inmutable toda definición que ya fue asignada", () => {
  const migration = readFileSync(SCHEDULE_TENANT_MIGRATION_PATH, "utf8");

  for (const table of ["work_schedules", "work_schedule_rules", "schedule_assignments"]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table}[\\s\\S]*?add column company_id`),
      `${table} debe adquirir una raíz tenant explícita`
    );
  }

  assert.match(migration, /work_schedule_rules_company_schedule_fkey/);
  assert.match(migration, /schedule_assignments_company_schedule_fkey/);
  assert.match(migration, /create temporary table schedule_tenant_clone_map/);
  assert.match(migration, /where a\.company_id <> s\.company_id/);
  assert.match(migration, /set work_schedule_id = m\.new_schedule_id/);
  assert.match(migration, /work_schedule_rules_20_protect_assigned/);
  assert.match(migration, /work_schedules_20_protect_assigned/);
  assert.match(migration, /Las reglas de un horario asignado son inmutables/);
  assert.match(migration, /insert into public\.work_schedules \([\s\S]*supersedes_schedule_id/);
  assert.match(migration, /v_existing\.definition_version \+ 1/);
  assert.match(migration, /where emp\.company_id = v_company_id/);
  assert.match(migration, /has_company_app_role\(v_company_id, 'ADMIN_RRHH'\)/);
  assert.doesNotMatch(migration, /current_user_role\(\) <> 'ADMIN_RRHH'/);
  assert.match(migration, /enforce_mfa_for_privileged\(\)/);
  assert.match(migration, /request_is_aal2\(\)/);
  assert.match(
    migration,
    /revoke insert, update, delete on public\.work_schedules from authenticated, service_role/
  );
  assert.match(
    migration,
    /revoke insert, update, delete on public\.work_schedule_rules from authenticated, service_role/
  );
  assert.match(
    migration,
    /revoke insert, update, delete on public\.schedule_assignments from authenticated, service_role/
  );
  assert.doesNotMatch(migration, /create policy work_schedules_write_admin/);
  assert.doesNotMatch(migration, /create policy work_schedule_rules_write_admin/);
  assert.doesNotMatch(migration, /create policy schedule_assignments_write_admin/);
  assert.match(
    migration,
    /create function public\.upsert_work_schedule\(\s*p_company_id uuid,[\s\S]*?security definer/
  );
  assert.match(
    migration,
    /create or replace function public\.apply_schedule_assignment\([\s\S]*?security definer/
  );
  assert.match(migration, /v_current\.rrhh_confirmed_at is not null/);
  assert.match(migration, /p_effective_from, v_current\.effective_to/);
  assert.match(migration, /payroll-source-mutation-v1/);
  assert.match(migration, /assert_arcotex_payroll_range_mutable/);
  assert.match(migration, /effective_from,\s+effective_to,[\s\S]*?v_current\.effective_to/);
  assert.match(
    migration,
    /create function public\.upsert_work_schedule\(\s*p_schedule_id uuid,[\s\S]*?0a4c0000-0000-0000-0000-000000000001/
  );
  assert.doesNotMatch(migration, /current_user_role\(\) = 'SUPER_ADMIN'/);
});

test("ningún llamador laboral reescribe schedule_assignments fuera del RPC", () => {
  const administration = readFileSync(SCHEDULE_ADMINISTRATION_PATH, "utf8");
  const seed = readFileSync(KNOWN_SCHEDULE_SEED_PATH, "utf8");

  assert.match(administration, /supabase\.rpc\("apply_schedule_assignment"/);
  assert.match(seed, /supabase\.rpc\("apply_schedule_assignment"/);
  assert.doesNotMatch(seed, /\.from\("schedule_assignments"\)[\s\S]{0,300}\.(?:insert|update|delete)\(/);
  assert.match(seed, /p_company_id: companyId/);
  assert.doesNotMatch(seed, /tenant\/legacy-workforce/);
});

// ---------------------------------------------------------------------------
// summarizeScheduleRules

test("summarizeScheduleRules: agrupa días consecutivos con el mismo tramo", () => {
  // "Horario estándar planta" real (seed de Fase 2): L-J 07:30-17:00, V 07:30-14:50.
  const label = summarizeScheduleRules([
    { dayOfWeek: 1, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 2, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 3, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 4, scheduledStart: "07:30:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 5, scheduledStart: "07:30:00", scheduledEnd: "14:50:00" },
  ]);
  assert.equal(label, "L-J 07:30-17:00 · V 07:30-14:50");
});

test("summarizeScheduleRules: un solo día no se escribe como rango", () => {
  const label = summarizeScheduleRules([{ dayOfWeek: 3, scheduledStart: "09:00:00", scheduledEnd: "13:00:00" }]);
  assert.equal(label, "X 09:00-13:00");
});

test("summarizeScheduleRules: los días libres no generan segmento, solo cortan la racha", () => {
  // Lunes y miércoles con el mismo tramo, martes libre: no deben fundirse en "L-X".
  const label = summarizeScheduleRules([
    { dayOfWeek: 1, scheduledStart: "08:00:00", scheduledEnd: "17:00:00" },
    { dayOfWeek: 2, scheduledStart: null, scheduledEnd: null },
    { dayOfWeek: 3, scheduledStart: "08:00:00", scheduledEnd: "17:00:00" },
  ]);
  assert.equal(label, "L 08:00-17:00 · X 08:00-17:00");
});

test("summarizeScheduleRules: sin reglas laborales lo dice explícitamente, nunca devuelve vacío", () => {
  assert.equal(summarizeScheduleRules([]), "Sin días laborales definidos");
  assert.equal(
    summarizeScheduleRules([{ dayOfWeek: 0, scheduledStart: null, scheduledEnd: null }]),
    "Sin días laborales definidos"
  );
});

test("summarizeScheduleRules: el domingo se lee al final, no al principio", () => {
  const label = summarizeScheduleRules([
    { dayOfWeek: 0, scheduledStart: "10:00:00", scheduledEnd: "14:00:00" },
    { dayOfWeek: 1, scheduledStart: "08:00:00", scheduledEnd: "17:00:00" },
  ]);
  assert.equal(label, "L 08:00-17:00 · D 10:00-14:00");
});

// ---------------------------------------------------------------------------
// buildScheduleAdminRows

const EMPLOYEES: RawEmployeeRow[] = [
  { id: "emp-1", display_name: "ANA PEREZ", employee_groups: { code: "PRODUCTION" } },
  { id: "emp-2", display_name: "BRUNO SOTO", employee_groups: [{ code: "INSTALLATION" }] },
  { id: "emp-3", display_name: "CARLA DIAZ", employee_groups: null },
];

test("buildScheduleAdminRows: refleja la asignación vigente con su nombre de horario", () => {
  const assignments: RawAssignmentRow[] = [
    {
      employee_id: "emp-1",
      work_schedule_id: "sched-std",
      effective_from: "2026-09-01",
      rrhh_confirmed_at: "2026-09-01T14:30:00.000Z",
      work_schedules: { name: "Horario estándar planta" },
    },
  ];
  const rows = buildScheduleAdminRows(EMPLOYEES, assignments, []);

  assert.equal(rows[0].workScheduleId, "sched-std");
  assert.equal(rows[0].workScheduleName, "Horario estándar planta");
  assert.equal(rows[0].effectiveFrom, "2026-09-01");
  assert.equal(rows[0].rrhhConfirmedAt, "2026-09-01T14:30:00.000Z");
  assert.equal(rows[0].timeControl, "NORMAL");
});

test("buildScheduleAdminRows: sin asignación queda en null, nunca inventa el horario general", () => {
  const rows = buildScheduleAdminRows(EMPLOYEES, [], []);
  assert.deepEqual(
    rows.map((r) => r.workScheduleId),
    [null, null, null]
  );
});

test("buildScheduleAdminRows: la exención se refleja con su base legal", () => {
  const policies: RawPolicyRow[] = [
    { employee_id: "emp-2", policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "ARTICLE_22" },
  ];
  const rows = buildScheduleAdminRows(EMPLOYEES, [], policies);

  assert.equal(rows[1].timeControl, "EXEMPT");
  assert.equal(rows[1].legalBasis, "ARTICLE_22");
});

test("buildScheduleAdminRows: una política NORMAL explícita no cuenta como exención", () => {
  const policies: RawPolicyRow[] = [{ employee_id: "emp-1", policy_code: "NORMAL", legal_basis: null }];
  const rows = buildScheduleAdminRows(EMPLOYEES, [], policies);

  assert.equal(rows[0].timeControl, "NORMAL");
  assert.equal(rows[0].legalBasis, null);
});

test("buildScheduleAdminRows: acepta el embed de PostgREST como objeto o como array de 1", () => {
  const rows = buildScheduleAdminRows(EMPLOYEES, [], []);
  assert.equal(rows[0].areaCode, "PRODUCTION"); // objeto
  assert.equal(rows[1].areaCode, "INSTALLATION"); // array
  assert.equal(rows[2].areaCode, null); // sin grupo
});

test("buildScheduleAdminRows: un exento con horario asignado muestra ambas cosas (la exención manda en el motor, pero el dato no se oculta)", () => {
  const assignments: RawAssignmentRow[] = [
    { employee_id: "emp-2", work_schedule_id: "sched-std", effective_from: "2026-09-01", work_schedules: { name: "Horario estándar planta" } },
  ];
  const policies: RawPolicyRow[] = [
    { employee_id: "emp-2", policy_code: "EXEMPT_FROM_TIME_CONTROL", legal_basis: "NO_MARKING_REQUIRED" },
  ];
  const rows = buildScheduleAdminRows(EMPLOYEES, assignments, policies);

  assert.equal(rows[1].timeControl, "EXEMPT");
  assert.equal(rows[1].workScheduleName, "Horario estándar planta");
});

test("exenciones: la frontera final deriva actor, valida rol de la empresa y bloquea DML directo", () => {
  const migration = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906200000_payroll_approval_and_security_hardening.sql",
  ), "utf8");
  const seed = readFileSync(path.resolve(
    import.meta.dirname,
    "../business-rules/seed-known-schedules.ts",
  ), "utf8");

  assert.match(migration, /create or replace function public\.set_time_control_exemption[\s\S]*?security definer/);
  assert.match(migration, /p_actor_id is distinct from v_actor/);
  assert.match(migration, /has_company_app_role\(v_company_id, 'ADMIN_RRHH'\)/);
  assert.match(migration, /perform public\.enforce_mfa_for_privileged\(\)/);
  assert.match(migration, /not coalesce\(public\.request_is_aal2\(\), false\)/);
  assert.match(migration, /revoke insert, update, delete on public\.employee_time_control_policies\s+from authenticated/);
  assert.match(migration, /TIME_CONTROL_EXEMPTION_SET_BY_RRHH/);
  assert.match(migration, /TIME_CONTROL_EXEMPTION_CLEARED_BY_RRHH/);
  assert.match(migration, /p\.effective_from <= current_date[\s\S]*?no puede borrarse desde su fecha inicial/);
  assert.match(migration, /delete from public\.employee_time_control_policies[\s\S]*?p\.effective_from > current_date/);
  assert.match(migration, /payroll-source-mutation-v1/);
  assert.ok(
    (migration.match(/assert_arcotex_payroll_range_mutable/g) ?? []).length >= 3,
    "set y clear deben validar cada rango que realmente cambian"
  );
  assert.match(migration, /effective_from, effective_to,[\s\S]*?v_current\.effective_to/);
  assert.match(seed, /supabase\.rpc\("set_time_control_exemption"/);
  assert.doesNotMatch(seed, /from\("employee_time_control_policies"\)\.insert/);
});
