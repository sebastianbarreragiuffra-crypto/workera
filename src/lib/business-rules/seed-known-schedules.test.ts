import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALEJANDRO_VALENCIA_SCHEDULE,
  GESTORA_OPERATIONAL_EVIDENCE_START,
  MARIA_VERA_SCHEDULE,
  MICHEL_MENDY_EXEMPTION,
  PABLO_GONZALEZ_SCHEDULE,
  seedKnownScheduleExceptions,
} from "./seed-known-schedules";

test("horarios individuales confirmados conservan exactamente sus jornadas", () => {
  assert.deepEqual(ALEJANDRO_VALENCIA_SCHEDULE, [
    { dayOfWeek: 1, start: "08:30:00", end: "18:00:00" },
    { dayOfWeek: 2, start: "08:30:00", end: "18:00:00" },
    { dayOfWeek: 3, start: "08:30:00", end: "18:00:00" },
    { dayOfWeek: 4, start: "08:30:00", end: "18:00:00" },
    { dayOfWeek: 5, start: "08:30:00", end: "15:50:00" },
  ]);
  assert.deepEqual(MARIA_VERA_SCHEDULE, [
    { dayOfWeek: 1, start: "08:00:00", end: "17:30:00" },
    { dayOfWeek: 2, start: "08:00:00", end: "17:30:00" },
    { dayOfWeek: 3, start: "08:00:00", end: "17:30:00" },
    { dayOfWeek: 4, start: "08:00:00", end: "17:30:00" },
    { dayOfWeek: 5, start: "08:00:00", end: "15:20:00" },
  ]);
  assert.deepEqual(PABLO_GONZALEZ_SCHEDULE.rules, [
    { dayOfWeek: 1, start: "07:30:00", end: "17:00:00" },
    { dayOfWeek: 2, start: "07:30:00", end: "17:00:00" },
    { dayOfWeek: 5, start: "11:00:00", end: "15:00:00" },
  ]);
  const pabloDays: number[] = PABLO_GONZALEZ_SCHEDULE.rules.map((rule) => rule.dayOfWeek);
  assert.equal(pabloDays.includes(3) || pabloDays.includes(4), false);
});

interface EmployeeFixture {
  id: string;
  first_name: string;
  last_name: string;
  external_workera_id: string | null;
  hire_date: string | null;
  source: string;
}

function mockSupabase(employees: EmployeeFixture[]) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let scheduleNumber = 0;

  function employeeQuery() {
    const filters: Array<{ kind: "eq" | "ilike"; column: string; value: string }> = [];
    const query = {
      select() { return query; },
      eq(column: string, value: string) { filters.push({ kind: "eq", column, value }); return query; },
      ilike(column: string, value: string) { filters.push({ kind: "ilike", column, value }); return query; },
      maybeSingle() {
        const data = filtered();
        return Promise.resolve({ data: data.length === 1 ? data[0] : null, error: null });
      },
      then(resolve: (value: { data: EmployeeFixture[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: filtered(), error: null }));
      },
    };
    function filtered() {
      return employees.filter((employee) => filters.every((filter) => {
          if (filter.column === "company_id") return true;
          const actual = String(employee[filter.column as keyof EmployeeFixture] ?? "").toUpperCase();
          return filter.kind === "eq" ? actual === filter.value.toUpperCase() : actual.includes(filter.value.replaceAll("%", "").toUpperCase());
      }));
    }
    return query;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === "employees") return employeeQuery();
      if (table === "work_schedules") {
        const query = { select() { return query; }, eq() { return query; }, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
        return query;
      }
      if (table === "employee_time_control_policies") {
        const query = { select() { return query; }, eq() { return query; }, is() { return query; }, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
        return query;
      }
      throw new Error(`Tabla inesperada: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "upsert_work_schedule") {
        scheduleNumber += 1;
        return Promise.resolve({ data: `schedule-${scheduleNumber}`, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, rpcCalls };
}

test("seed seguro: Michel se resuelve por código estable, Claudio reutiliza su ficha provisional y las fechas usan contratación o límite operativo", async () => {
  const { client, rpcCalls } = mockSupabase([
    { id: "alejandro", first_name: "ALEJANDRO", last_name: "VALENCIA", external_workera_id: "A-1", hire_date: "2024-01-10", source: "workera" },
    { id: "maria", first_name: "MARIA", last_name: "VERA", external_workera_id: "M-1", hire_date: null, source: "workera" },
    { id: "claudio", first_name: "CLAUDIO", last_name: "BARRERA", external_workera_id: "LOCAL-PROVISIONAL:CLAUDIO-BARRERA", hire_date: null, source: "local_provisional" },
    { id: "michel-correcto", first_name: "MICHEL ANDRE", last_name: "MENDY MUÑOZ", external_workera_id: MICHEL_MENDY_EXEMPTION.externalWorkeraId, hire_date: "2023-08-01", source: "workera" },
    { id: "michel-otro", first_name: "MICHEL ANDRE", last_name: "MENDY LAGOS", external_workera_id: "OTRO", hire_date: null, source: "workera" },
    { id: "pablo", first_name: "PABLO ANDRES", last_name: "GONZALEZ PINTO", external_workera_id: PABLO_GONZALEZ_SCHEDULE.externalWorkeraId, hire_date: null, source: "workera" },
  ]);

  const result = await seedKnownScheduleExceptions(client, "company", GESTORA_OPERATIONAL_EVIDENCE_START, "actor");
  const exemption = rpcCalls.find((call) => call.name === "set_time_control_exemption" && call.args.p_legal_basis === "ARTICLE_22");
  const claudioExemption = rpcCalls.find((call) => call.name === "set_time_control_exemption" && call.args.p_legal_basis === "NO_MARKING_REQUIRED");
  const assignments = rpcCalls.filter((call) => call.name === "apply_schedule_assignment");

  assert.equal(exemption?.args.p_employee_id, "michel-correcto");
  assert.equal(exemption?.args.p_legal_basis, "ARTICLE_22");
  assert.equal(exemption?.args.p_effective_from, "2023-08-01");
  assert.equal(claudioExemption?.args.p_employee_id, "claudio");
  assert.equal(claudioExemption?.args.p_effective_from, GESTORA_OPERATIONAL_EVIDENCE_START);
  assert.equal(assignments.find((call) => call.args.p_employee_id === "maria")?.args.p_effective_from, GESTORA_OPERATIONAL_EVIDENCE_START);
  assert.equal(assignments.find((call) => call.args.p_employee_id === "pablo")?.args.p_effective_from, GESTORA_OPERATIONAL_EVIDENCE_START);
  assert.equal(result.resolved.some((row) => row.label === "Claudio Barrera"), true);
  assert.equal(rpcCalls.some((call) => call.name === "set_time_control_exemption" && call.args.p_employee_id === "michel-otro"), false);
});

test("seed seguro: si no existe el código Workera confirmado de Michel, no aplica ninguna exención por parecido de nombre", async () => {
  const { client, rpcCalls } = mockSupabase([
    { id: "claudio", first_name: "CLAUDIO", last_name: "BARRERA", external_workera_id: "LOCAL-PROVISIONAL:CLAUDIO-BARRERA", hire_date: null, source: "local_provisional" },
    { id: "michel-otro", first_name: "MICHEL ANDRE", last_name: "MENDY LAGOS", external_workera_id: "OTRO", hire_date: null, source: "workera" },
  ]);

  const result = await seedKnownScheduleExceptions(client, "company", GESTORA_OPERATIONAL_EVIDENCE_START, "actor");

  assert.equal(rpcCalls.some((call) => call.name === "set_time_control_exemption" && call.args.p_legal_basis === "ARTICLE_22"), false);
  assert.equal(result.unresolved.some((row) => row.label === "Michel André Mendy Muñoz" && row.reason === "STABLE_IDENTIFIER_NOT_FOUND"), true);
});

test("seed seguro: rechaza una fecha base inventada antes de tocar empleados o políticas", async () => {
  const { client, rpcCalls } = mockSupabase([]);

  await assert.rejects(
    () => seedKnownScheduleExceptions(client, "company", "2025-10-16", "actor"),
    /2026-08-24/,
  );
  assert.equal(rpcCalls.length, 0);
});
