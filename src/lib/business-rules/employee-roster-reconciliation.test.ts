import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapEmployeesFromRoster, resolveEmployeeByFullName } from "./employee-roster-reconciliation";
import type { HttpWorkeraClient } from "../workera/http-client";

interface InsertedEmployeeRow {
  external_workera_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
}

function createMockSupabase(employees: { external_workera_id?: string; id?: string; first_name?: string; last_name?: string }[]) {
  const inserted: InsertedEmployeeRow[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(): any {
      const builder = {
        select() {
          return builder;
        },
        insert(rows: InsertedEmployeeRow | InsertedEmployeeRow[]) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          onResolve({ data: employees, error: null });
        },
      };
      return builder;
    },
    inserted,
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
  const mock = createMockSupabase([{ external_workera_id: "90000017" }]);
  const client = fakeWorkeraClient([{ code: "90000017", firstName: "JUAN", lastName: "PEREZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client);

  assert.equal(result.totalRosterEmployees, 1);
  assert.equal(result.alreadyExisting, 1);
  assert.equal(result.newlyBootstrapped, 0);
  assert.equal(mock.inserted.length, 0);
});

test("bootstrapEmployeesFromRoster: código nuevo -> se bootstrapea con campos mínimos", async () => {
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
