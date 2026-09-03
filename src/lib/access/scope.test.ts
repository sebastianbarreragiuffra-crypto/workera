import { test } from "node:test";
import assert from "node:assert/strict";
import { areasVisibleToRole, assertAreaAccessAllowed, assertEmployeeAccessAllowed, parseAreaCode, AreaAccessError } from "./scope";

test("SUPER_ADMIN y ADMIN_RRHH pueden ver las 3 áreas", () => {
  assert.deepEqual(areasVisibleToRole("SUPER_ADMIN"), ["PRODUCTION", "INSTALLATION", "ADMINISTRATION"]);
  assert.deepEqual(areasVisibleToRole("ADMIN_RRHH"), ["PRODUCTION", "INSTALLATION", "ADMINISTRATION"]);
});

test("SUPERVISOR_PRODUCTION solo ve PRODUCTION", () => {
  assert.deepEqual(areasVisibleToRole("SUPERVISOR_PRODUCTION"), ["PRODUCTION"]);
});

test("SUPERVISOR_INSTALLATION solo ve INSTALLATION", () => {
  assert.deepEqual(areasVisibleToRole("SUPERVISOR_INSTALLATION"), ["INSTALLATION"]);
});

test("assertAreaAccessAllowed: Production supervisor no puede acceder a Installation", () => {
  assert.throws(() => assertAreaAccessAllowed("SUPERVISOR_PRODUCTION", "INSTALLATION"), AreaAccessError);
});

test("assertAreaAccessAllowed: Installation supervisor no puede acceder a Production", () => {
  assert.throws(() => assertAreaAccessAllowed("SUPERVISOR_INSTALLATION", "PRODUCTION"), AreaAccessError);
});

test("assertAreaAccessAllowed: RRHH puede acceder a cualquier área, incluida Administration", () => {
  assert.doesNotThrow(() => assertAreaAccessAllowed("ADMIN_RRHH", "ADMINISTRATION"));
});

function mockSupabaseWithEmployeeGroup(code: string | null) {
  return {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        single() {
          return Promise.resolve({ data: code ? { employee_groups: { code } } : null, error: code ? null : { message: "no encontrado" } });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("assertEmployeeAccessAllowed: supervisor de Producción puede acceder a un empleado de Producción", async () => {
  const supabase = mockSupabaseWithEmployeeGroup("PRODUCTION");
  const area = await assertEmployeeAccessAllowed(supabase, "SUPERVISOR_PRODUCTION", "emp-1");
  assert.equal(area, "PRODUCTION");
});

test("assertEmployeeAccessAllowed: supervisor de Producción NO puede acceder a un empleado de Instalación", async () => {
  const supabase = mockSupabaseWithEmployeeGroup("INSTALLATION");
  await assert.rejects(() => assertEmployeeAccessAllowed(supabase, "SUPERVISOR_PRODUCTION", "emp-1"), AreaAccessError);
});

test("assertEmployeeAccessAllowed: empleado sin área asignada -> AreaAccessError, nunca se asume un área", async () => {
  const supabase = mockSupabaseWithEmployeeGroup(null as unknown as string);
  await assert.rejects(() => assertEmployeeAccessAllowed(supabase, "ADMIN_RRHH", "emp-1"));
});

// ---------------------------------------------------------------------------
// parseAreaCode: filtro para el `?area=` que llega por URL
// ---------------------------------------------------------------------------

test("parseAreaCode: acepta las tres áreas reales", () => {
  assert.equal(parseAreaCode("PRODUCTION"), "PRODUCTION");
  assert.equal(parseAreaCode("INSTALLATION"), "INSTALLATION");
  assert.equal(parseAreaCode("ADMINISTRATION"), "ADMINISTRATION");
});

test("parseAreaCode: cualquier otra cosa es null, nunca un área inventada", () => {
  for (const value of ["", "  ", "produccion", "production", "PRODUCTION ", "ADMIN", "../../etc", undefined, null]) {
    assert.equal(parseAreaCode(value), null, `debería rechazar ${JSON.stringify(value)}`);
  }
});

test("parseAreaCode: distingue un área desconocida de una real pero ajena al rol", () => {
  // Desconocida -> null, la página la ignora y muestra "Todas".
  assert.equal(parseAreaCode("no-existe"), null);
  // Real pero ajena -> sí es un AreaCode, y el rechazo le toca a
  // assertAreaAccessAllowed, que es quien conoce el rol.
  const ajena = parseAreaCode("INSTALLATION");
  assert.equal(ajena, "INSTALLATION");
  assert.throws(() => assertAreaAccessAllowed("SUPERVISOR_PRODUCTION", ajena!), AreaAccessError);
});
