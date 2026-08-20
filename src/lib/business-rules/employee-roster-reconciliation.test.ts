import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapEmployeesFromRoster, resolveEmployeeByFullName } from "./employee-roster-reconciliation";
import type { HttpWorkeraClient } from "../workera/http-client";

interface FakeEmployee {
  id?: string;
  external_workera_id?: string;
  source?: string;
  first_name?: string;
  last_name?: string;
}
interface InsertedEmployeeRow {
  external_workera_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  source: string;
}

function createMockSupabase(employees: FakeEmployee[]) {
  const inserted: InsertedEmployeeRow[] = [];
  const updated: { id: string; patch: Record<string, unknown> }[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(): any {
      const builder = {
        select() {
          return builder;
        },
        eq(_col: string, value: string) {
          // Solo usado por resolveEmployeeByFullName(sourceEquals) en estos tests -- filtra por source.
          return { then: (onResolve: (r: { data: unknown; error: unknown }) => void) => onResolve({ data: employees.filter((e) => e.source === value), error: null }) };
        },
        insert(rows: InsertedEmployeeRow | InsertedEmployeeRow[]) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updated.push({ id, patch });
              return Promise.resolve({ error: null });
            },
          };
        },
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          onResolve({ data: employees, error: null });
        },
      };
      return builder;
    },
    inserted,
    updated,
  };
}

function fakeWorkeraClient(employees: { code: string; firstName: string | null; lastName: string | null; employeeStatus?: string | null; branchOfficeCode?: string | null; departmentCode?: string | null }[]): HttpWorkeraClient {
  return {
    getAllEmployeeRoster: async () => ({
      employees: employees.map((e) => ({
        employeeStatus: null,
        branchOfficeCode: null,
        departmentCode: null,
        ...e,
      })),
      pagesFetched: 1,
      totalResult: employees.length,
    }),
  } as unknown as HttpWorkeraClient;
}

// -----------------------------------------------------------------------------
// bootstrapEmployeesFromRoster

test("bootstrapEmployeesFromRoster: código ya existente -> NO se reinserta, cuenta como alreadyExisting", async () => {
  const mock = createMockSupabase([{ external_workera_id: "90000017", source: "workera" }]);
  const client = fakeWorkeraClient([{ code: "90000017", firstName: "JUAN", lastName: "PEREZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.totalRosterEmployees, 1);
  assert.equal(result.alreadyExisting, 1);
  assert.equal(result.newlyBootstrapped, 0);
  assert.equal(mock.inserted.length, 0);
});

test("bootstrapEmployeesFromRoster: código nuevo, sin candidato excel_roster -> se bootstrapea con campos mínimos y source='workera'", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([{ code: "90000099", firstName: "MICHEL", lastName: "MENDY" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.newlyBootstrapped, 1);
  assert.equal(mock.inserted.length, 1);
  assert.deepEqual(mock.inserted[0], {
    external_workera_id: "90000099",
    first_name: "MICHEL",
    last_name: "MENDY",
    display_name: "MICHEL MENDY",
    source: "workera",
  });
});

test("bootstrapEmployeesFromRoster: sin nombre/apellido -> usa placeholder, nunca inventa un nombre", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([{ code: "90000100", firstName: null, lastName: null }]);

  await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(mock.inserted[0].first_name, "(sin nombre Workera)");
  assert.equal(mock.inserted[0].last_name, "(sin apellido Workera)");
});

test("bootstrapEmployeesFromRoster: código duplicado dentro del mismo roster -> solo se inserta una vez", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([
    { code: "90000200", firstName: "ANA", lastName: "SOTO" },
    { code: "90000200", firstName: "ANA", lastName: "SOTO" },
  ]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.newlyBootstrapped, 1);
  assert.equal(mock.inserted.length, 1);
});

test("bootstrapEmployeesFromRoster: nombre exacto coincide con UN empleado excel_roster sin vincular -> se PROMUEVE (nunca duplica), no se inserta fila nueva", async () => {
  const mock = createMockSupabase([{ id: "emp-excel-1", external_workera_id: "EXCEL-11111111-1", source: "excel_roster", first_name: "PEDRO", last_name: "GOMEZ" }]);
  const client = fakeWorkeraClient([{ code: "90000300", firstName: "PEDRO", lastName: "GOMEZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.promotedFromExcelRoster, 1);
  assert.equal(result.newlyBootstrapped, 0);
  assert.equal(mock.inserted.length, 0, "nunca debe crear una fila nueva cuando el nombre matchea exactamente un empleado excel_roster");
  assert.deepEqual(mock.updated, [{ id: "emp-excel-1", patch: { external_workera_id: "90000300", source: "workera" } }]);
});

test("bootstrapEmployeesFromRoster: nombre coincide con DOS empleados excel_roster -> nunca elige uno al azar, inserta fila nueva y marca reconciliationRequired", async () => {
  const mock = createMockSupabase([
    { id: "emp-excel-1", external_workera_id: "EXCEL-11111111-1", source: "excel_roster", first_name: "PEDRO", last_name: "GOMEZ" },
    { id: "emp-excel-2", external_workera_id: "EXCEL-22222222-2", source: "excel_roster", first_name: "PEDRO", last_name: "GOMEZ" },
  ]);
  const client = fakeWorkeraClient([{ code: "90000301", firstName: "PEDRO", lastName: "GOMEZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.newlyBootstrapped, 1, "se crea una fila nueva para no perder al empleado real de Workera");
  assert.equal(mock.updated.length, 0, "nunca promueve automáticamente cuando hay ambigüedad");
  assert.equal(result.reconciliationRequired.length, 1);
  assert.equal(result.reconciliationRequired[0].rosterCode, "90000301");
  assert.equal(result.reconciliationRequired[0].matchedNames.length, 2);
});

test("bootstrapEmployeesFromRoster: nunca reconcilia por nombre contra un empleado ya source='workera' (solo excel_roster sin vincular es candidato)", async () => {
  const mock = createMockSupabase([{ id: "emp-workera-1", external_workera_id: "90000400", source: "workera", first_name: "LUIS", last_name: "TORRES" }]);
  const client = fakeWorkeraClient([{ code: "90000401", firstName: "LUIS", lastName: "TORRES" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.newlyBootstrapped, 1, "un código nuevo de Workera nunca se fusiona contra otro empleado ya confirmado por Workera, aunque el nombre coincida");
  assert.equal(mock.updated.length, 0);
});

// -----------------------------------------------------------------------------
// resolveEmployeeByFullName

test("resolveEmployeeByFullName: exactamente 1 coincidencia normalizada -> resolved", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "MICHEL", last_name: "MENDY" }]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy");
  assert.equal(result.resolved, true);
  assert.equal(result.employeeId, "emp-1");
});

test("resolveEmployeeByFullName: coincide ignorando acentos/mayúsculas/espacios", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "CLAUDIO ANDRES", last_name: "BARRERA" }]);
  const result = await resolveEmployeeByFullName(mock as never, "  claudio   andrés   barrera  ");
  assert.equal(result.resolved, true);
});

test("resolveEmployeeByFullName: 0 coincidencias -> unresolved, nunca se adivina", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "OTRO", last_name: "NOMBRE" }]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy");
  assert.equal(result.resolved, false);
  assert.equal(result.matchCount, 0);
  assert.equal(result.employeeId, null);
});

test("resolveEmployeeByFullName: 2+ coincidencias -> unresolved, nunca se elige uno al azar", async () => {
  const mock = createMockSupabase([
    { id: "emp-1", first_name: "MICHEL", last_name: "MENDY" },
    { id: "emp-2", first_name: "MICHEL", last_name: "MENDY" },
  ]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy");
  assert.equal(result.resolved, false);
  assert.equal(result.matchCount, 2);
});

test("resolveEmployeeByFullName: nombre parcial NO es suficiente (nunca fuzzy) -- segundo nombre no coincidente no matchea", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "MICHEL ALEXANDER", last_name: "MENDY" }]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy");
  assert.equal(result.resolved, false, "un segundo nombre real que el buscador no conoce nunca debe producir un match automático");
});

test("resolveEmployeeByFullName: sourceEquals acota la búsqueda -- nunca reconcilia contra alguien de otra fuente", async () => {
  const mock = createMockSupabase([
    { id: "emp-1", first_name: "MICHEL", last_name: "MENDY", source: "workera" },
    { id: "emp-2", first_name: "OTRO", last_name: "NOMBRE", source: "excel_roster" },
  ]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy", { sourceEquals: "excel_roster" });
  assert.equal(result.resolved, false, "aunque el nombre existe, está en source='workera', no en el filtro solicitado");
});
