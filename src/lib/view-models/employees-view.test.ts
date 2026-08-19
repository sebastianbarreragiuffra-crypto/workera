import { test } from "node:test";
import assert from "node:assert/strict";
import { getEmployeeRoster } from "./employees-view";

interface FakeEmployeeRow {
  id: string;
  display_name: string;
  active: boolean;
  rut: string | null;
  employee_groups: { code: string } | null;
}

function mockSupabase(rows: FakeEmployeeRow[]) {
  return {
    from(table: string) {
      if (table === "employees") {
        let filtered = rows;
        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          eq() {
            return builder;
          },
          ilike(_col: string, pattern: string) {
            const needle = pattern.replace(/%/g, "").toLowerCase();
            filtered = filtered.filter((r) => r.display_name.toLowerCase().includes(needle));
            return builder;
          },
          then(onResolve: (r: { data: unknown; error: null }) => void) {
            onResolve({ data: filtered, error: null });
          },
        };
        return builder;
      }
      // employee_time_control_policies -- ninguna política activa -> NORMAL para todos en este mock.
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        lte() {
          return this;
        },
        or() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const SAMPLE_ROWS: FakeEmployeeRow[] = [
  { id: "e1", display_name: "Juan Pérez", active: true, rut: "12345678-9", employee_groups: { code: "PRODUCTION" } },
  { id: "e2", display_name: "Ana Soto", active: true, rut: null, employee_groups: { code: "INSTALLATION" } },
  { id: "e3", display_name: "Sin Área", active: true, rut: null, employee_groups: null },
];

test("getEmployeeRoster: nunca expone el campo RUT en la vista, aunque exista en la fila real", async () => {
  const supabase = mockSupabase(SAMPLE_ROWS);
  const roster = await getEmployeeRoster(supabase, "ADMIN_RRHH", {}, "2026-08-19");

  for (const entry of roster) {
    assert.ok(!("rut" in entry), "EmployeeRosterEntry no debe tener una propiedad rut");
  }
});

test("getEmployeeRoster: SUPERVISOR_PRODUCTION solo ve empleados de PRODUCTION (nunca los sin área)", async () => {
  const supabase = mockSupabase(SAMPLE_ROWS);
  const roster = await getEmployeeRoster(supabase, "SUPERVISOR_PRODUCTION", {}, "2026-08-19");

  assert.equal(roster.length, 1);
  assert.equal(roster[0].areaCode, "PRODUCTION");
});

test("getEmployeeRoster: RRHH ve todas las áreas, incluidos empleados sin área asignada", async () => {
  const supabase = mockSupabase(SAMPLE_ROWS);
  const roster = await getEmployeeRoster(supabase, "ADMIN_RRHH", {}, "2026-08-19");

  assert.equal(roster.length, 3);
});

test("getEmployeeRoster: filtro explícito de área fuera del alcance del rol -> rechaza (AreaAccessError)", async () => {
  const supabase = mockSupabase(SAMPLE_ROWS);
  await assert.rejects(() => getEmployeeRoster(supabase, "SUPERVISOR_PRODUCTION", { areaCode: "INSTALLATION" }, "2026-08-19"));
});
