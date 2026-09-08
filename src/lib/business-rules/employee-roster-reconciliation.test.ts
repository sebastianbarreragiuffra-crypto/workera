import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFromWorkeraEmployeeStatus, bootstrapEmployeesFromRoster, resolveEmployeeByFullName } from "./employee-roster-reconciliation";
import type { HttpWorkeraClient } from "../workera/http-client";

const TEST_COMPANY_ID = "11111111-1111-4111-8111-111111111111";

interface FakeEmployee {
  id?: string;
  external_workera_id?: string;
  source?: string;
  first_name?: string;
  last_name?: string;
  active?: boolean;
  updated_at?: string;
  company_id?: string;
}
interface InsertedEmployeeRow {
  company_id: string;
  external_workera_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  source: string;
  active: boolean;
}

function createMockSupabase(employees: FakeEmployee[]) {
  const storedEmployees = employees.map((employee, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    active: true,
    updated_at: "2026-09-07T12:00:00.000Z",
    company_id: TEST_COMPANY_ID,
    ...employee,
  }));
  const inserted: InsertedEmployeeRow[] = [];
  const updated: { filters: { column: string; value: string }[]; patch: Record<string, unknown> }[] = [];
  const selected: { column: string; value: string }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(): any {
      const queryFilters: { column: string; value: string }[] = [];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: string) {
          selected.push({ column, value });
          queryFilters.push({ column, value });
          return builder;
        },
        insert(rows: InsertedEmployeeRow | InsertedEmployeeRow[]) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        update(patch: Record<string, unknown>) {
          const filters: { column: string; value: string }[] = [];
          const updateBuilder = {
            eq(column: string, value: string) {
              filters.push({ column, value });
              return updateBuilder;
            },
            then(onResolve: (r: { error: unknown }) => void) {
              updated.push({ filters: [...filters], patch });
              onResolve({ error: null });
            },
          };
          return updateBuilder;
        },
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          const filtered = storedEmployees.filter((employee) =>
            queryFilters.every(({ column, value }) => employee[column as keyof typeof employee] === value),
          );
          onResolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const companyId = args.p_company_id as string;
      const statusUpdates = args.p_status_updates as { id: string; external_workera_id: string; prior_active: boolean; prior_updated_at: string; active: boolean }[];
      const promotions = args.p_promotions as { id: string; external_workera_id: string; prior_active: boolean; prior_updated_at: string; active: boolean }[];
      const insertRows = args.p_insert_rows as Omit<InsertedEmployeeRow, "company_id" | "source">[];
      for (const row of statusUpdates) {
        updated.push({
          filters: [
            { column: "company_id", value: companyId },
            { column: "external_workera_id", value: row.external_workera_id },
          ],
          patch: { active: row.active },
        });
      }
      for (const row of promotions) {
        updated.push({
          filters: [
            { column: "company_id", value: companyId },
            { column: "id", value: row.id },
          ],
          patch: { external_workera_id: row.external_workera_id, source: "workera", active: row.active },
        });
      }
      inserted.push(...insertRows.map((row) => ({ ...row, company_id: companyId, source: "workera" })));
      return Promise.resolve({
        data: {
          status_updated_count:
            statusUpdates.length + promotions.filter((row) => row.prior_active !== row.active).length,
          promoted_count: promotions.length,
          inserted_count: insertRows.length,
        },
        error: null,
      });
    },
    inserted,
    updated,
    selected,
    rpcCalls,
  };
}

function fakeWorkeraClient(employees: { code: string; firstName: string | null; lastName: string | null; employeeStatus?: string | null; branchOfficeCode?: string | null; departmentCode?: string | null }[]): HttpWorkeraClient {
  return {
    getAllEmployeeRoster: async () => ({
      employees: employees.map((e) => ({
        employeeStatus: "ACTIVO",
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

test("activeFromWorkeraEmployeeStatus: sólo interpreta ACTIVO/INACTIVO y no infiere valores desconocidos", () => {
  assert.equal(activeFromWorkeraEmployeeStatus("ACTIVO"), true);
  assert.equal(activeFromWorkeraEmployeeStatus(" activo "), true);
  assert.equal(activeFromWorkeraEmployeeStatus("INACTIVO"), false);
  assert.equal(activeFromWorkeraEmployeeStatus("inactivo"), false);
  assert.equal(activeFromWorkeraEmployeeStatus("SUSPENDIDO"), null);
  assert.equal(activeFromWorkeraEmployeeStatus(""), null);
  assert.equal(activeFromWorkeraEmployeeStatus(null), null);
});

test("bootstrapEmployeesFromRoster: rechaza companyId inválido antes de leer o mutar datos", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([{ code: "EMP-1", firstName: "UNO", lastName: "PRUEBA" }]);

  await assert.rejects(
    () => bootstrapEmployeesFromRoster(mock as never, client, "empresa-no-uuid"),
    /companyId inválido/,
  );
  assert.equal(mock.selected.length, 0);
  assert.equal(mock.inserted.length, 0);
  assert.equal(mock.updated.length, 0);
});

test("bootstrapEmployeesFromRoster: código ya existente -> NO se reinserta, cuenta como alreadyExisting", async () => {
  const mock = createMockSupabase([{ external_workera_id: "90000017", source: "workera" }]);
  const client = fakeWorkeraClient([{ code: "90000017", firstName: "JUAN", lastName: "PEREZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.totalRosterEmployees, 1);
  assert.equal(result.alreadyExisting, 1);
  assert.equal(result.newlyBootstrapped, 0);
  assert.equal(result.workeraActiveCount, 1);
  assert.equal(result.statusUnchangedCount, 1);
  assert.deepEqual(mock.selected, [{ column: "company_id", value: TEST_COMPANY_ID }]);
  assert.equal(mock.inserted.length, 0);
});

test("bootstrapEmployeesFromRoster: sincroniza vigencia conocida por external_workera_id y reporta sus conteos", async () => {
  const mock = createMockSupabase([
    { external_workera_id: "EMP-INACTIVO", source: "workera", active: true },
    { external_workera_id: "EMP-REACTIVADO", source: "workera", active: false },
    { external_workera_id: "EMP-SIN-CAMBIO", source: "workera", active: false },
  ]);
  const client = fakeWorkeraClient([
    { code: "EMP-INACTIVO", firstName: "UNO", lastName: "PRUEBA", employeeStatus: "INACTIVO" },
    { code: "EMP-REACTIVADO", firstName: "DOS", lastName: "PRUEBA", employeeStatus: "ACTIVO" },
    { code: "EMP-SIN-CAMBIO", firstName: "TRES", lastName: "PRUEBA", employeeStatus: "INACTIVO" },
  ]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.alreadyExisting, 3);
  assert.equal(result.workeraActiveCount, 1);
  assert.equal(result.workeraInactiveCount, 2);
  assert.equal(result.unknownStatusCount, 0);
  assert.equal(result.statusUpdatedCount, 2);
  assert.equal(result.statusUnchangedCount, 1);
  assert.equal(result.skippedUnknownStatusCount, 0);
  assert.deepEqual(mock.updated, [
    { filters: [{ column: "company_id", value: TEST_COMPANY_ID }, { column: "external_workera_id", value: "EMP-INACTIVO" }], patch: { active: false } },
    { filters: [{ column: "company_id", value: TEST_COMPANY_ID }, { column: "external_workera_id", value: "EMP-REACTIVADO" }], patch: { active: true } },
  ]);
  assert.equal(mock.rpcCalls.length, 1, "todo el plan se entrega a una única transacción RPC");
  assert.deepEqual(
    (mock.rpcCalls[0].args.p_status_updates as { external_workera_id: string; prior_active: boolean; prior_updated_at: string; active: boolean }[])
      .map(({ external_workera_id, prior_active, prior_updated_at, active }) => ({ external_workera_id, prior_active, prior_updated_at, active })),
    [
      { external_workera_id: "EMP-INACTIVO", prior_active: true, prior_updated_at: "2026-09-07T12:00:00.000Z", active: false },
      { external_workera_id: "EMP-REACTIVADO", prior_active: false, prior_updated_at: "2026-09-07T12:00:00.000Z", active: true },
    ],
  );
});

test("bootstrapEmployeesFromRoster: código nuevo, sin candidato excel_roster -> se bootstrapea con campos mínimos y source='workera'", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([{ code: "90000099", firstName: "MICHEL", lastName: "MENDY" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.newlyBootstrapped, 1);
  assert.equal(mock.inserted.length, 1);
  assert.deepEqual(mock.inserted[0], {
    company_id: TEST_COMPANY_ID,
    external_workera_id: "90000099",
    first_name: "MICHEL",
    last_name: "MENDY",
    display_name: "MICHEL MENDY",
    source: "workera",
    active: true,
  });
});

test("bootstrapEmployeesFromRoster: una ficha nueva INACTIVO se inserta explícitamente con active=false", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([{ code: "EMP-NUEVO-INACTIVO", firstName: "NUEVO", lastName: "INACTIVO", employeeStatus: "INACTIVO" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.newlyBootstrapped, 1);
  assert.equal(result.workeraInactiveCount, 1);
  assert.equal(result.unknownStatusCount, 0);
  assert.equal(mock.inserted[0].active, false);
});

test("bootstrapEmployeesFromRoster: un estado desconocido bloquea todo el lote antes de consultar o mutar la base", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([
    { code: "EMP-CONOCIDO", firstName: "CONOCIDO", lastName: "ACTIVO", employeeStatus: "ACTIVO" },
    { code: "EMP-NUEVO-DESCONOCIDO", firstName: "NUEVO", lastName: "SIN ESTADO", employeeStatus: null },
  ]);

  await assert.rejects(
    () => bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID),
    /1 estado\(s\).*no reconocido/,
  );
  assert.equal(mock.selected.length, 0);
  assert.equal(mock.inserted.length, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

test("bootstrapEmployeesFromRoster: sin nombre/apellido -> usa placeholder, nunca inventa un nombre", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([{ code: "90000100", firstName: null, lastName: null }]);

  await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(mock.inserted[0].first_name, "(sin nombre Workera)");
  assert.equal(mock.inserted[0].last_name, "(sin apellido Workera)");
});

test("bootstrapEmployeesFromRoster: código duplicado dentro del mismo roster -> solo se inserta una vez", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([
    { code: "90000200", firstName: "ANA", lastName: "SOTO" },
    { code: "90000200", firstName: " ana ", lastName: "Sotó" },
  ]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.newlyBootstrapped, 1);
  assert.equal(result.duplicateRosterCount, 1);
  assert.equal(result.workeraActiveCount, 1);
  assert.equal(mock.inserted.length, 1);
});

test("bootstrapEmployeesFromRoster: estados ACTIVO/INACTIVO contradictorios para un mismo código abortan antes de mutar", async () => {
  const mock = createMockSupabase([]);
  const client = fakeWorkeraClient([
    { code: "EMP-CONTRADICTORIO", firstName: "MISMA", lastName: "PERSONA", employeeStatus: "ACTIVO" },
    { code: "EMP-CONTRADICTORIO", firstName: "MISMA", lastName: "PERSONA", employeeStatus: "INACTIVO" },
  ]);

  await assert.rejects(
    () => bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID),
    /estados ACTIVO\/INACTIVO contradictorios/,
  );
  assert.equal(mock.inserted.length, 0);
  assert.equal(mock.updated.length, 0);
});

test("bootstrapEmployeesFromRoster: un mismo código con nombres normalizados contradictorios aborta sin filtrar PII", async () => {
  const mock = createMockSupabase([]);
  const sensitiveCode = "CODIGO-PERSONAL-SECRETO";
  const sensitiveFirstName = "ALICIA-SECRETA";
  const sensitiveLastName = "ROJAS-SECRETA";
  const client = fakeWorkeraClient([
    { code: sensitiveCode, firstName: sensitiveFirstName, lastName: sensitiveLastName, employeeStatus: "ACTIVO" },
    { code: sensitiveCode, firstName: "OTRA-PERSONA-SECRETA", lastName: "DISTINTA-SECRETA", employeeStatus: "ACTIVO" },
  ]);

  await assert.rejects(
    () => bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /nombres normalizados contradictorios/);
      assert.doesNotMatch(error.message, /CODIGO-PERSONAL|ALICIA|ROJAS|OTRA-PERSONA|DISTINTA/);
      return true;
    },
  );
  assert.equal(mock.selected.length, 0, "la contradicción se detecta antes de consultar la base");
  assert.equal(mock.rpcCalls.length, 0);
  assert.equal(mock.inserted.length, 0);
  assert.equal(mock.updated.length, 0);
});

test("bootstrapEmployeesFromRoster: nombre exacto coincide con UN empleado excel_roster sin vincular -> se PROMUEVE (nunca duplica), no se inserta fila nueva", async () => {
  const mock = createMockSupabase([{ id: "emp-excel-1", external_workera_id: "EXCEL-11111111-1", source: "excel_roster", first_name: "PEDRO", last_name: "GOMEZ" }]);
  const client = fakeWorkeraClient([{ code: "90000300", firstName: "PEDRO", lastName: "GOMEZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.promotedFromExcelRoster, 1);
  assert.equal(result.newlyBootstrapped, 0);
  assert.equal(mock.inserted.length, 0, "nunca debe crear una fila nueva cuando el nombre matchea exactamente un empleado excel_roster");
  assert.deepEqual(mock.updated, [{ filters: [{ column: "company_id", value: TEST_COMPANY_ID }, { column: "id", value: "emp-excel-1" }], patch: { external_workera_id: "90000300", source: "workera", active: true } }]);
  assert.deepEqual(mock.rpcCalls[0].args.p_promotions, [{
    id: "emp-excel-1",
    prior_external_workera_id: "EXCEL-11111111-1",
    external_workera_id: "90000300",
    prior_active: true,
    prior_updated_at: "2026-09-07T12:00:00.000Z",
    active: true,
  }]);
  assert.equal(result.statusUpdatedCount, 0);
  assert.equal(result.statusUnchangedCount, 1);
});

test("bootstrapEmployeesFromRoster: una promoción false→true cuenta como cambio de vigencia del RPC", async () => {
  const mock = createMockSupabase([{
    id: "emp-excel-inactivo",
    external_workera_id: "EXCEL-INACTIVO",
    source: "excel_roster",
    first_name: "PERSONA",
    last_name: "REACTIVADA",
    active: false,
  }]);
  const client = fakeWorkeraClient([{
    code: "WORKERA-REACTIVADO",
    firstName: "PERSONA",
    lastName: "REACTIVADA",
    employeeStatus: "ACTIVO",
  }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.promotedToWorkera, 1);
  assert.equal(result.statusUpdatedCount, 1);
  assert.equal(result.statusUnchangedCount, 0);
  assert.deepEqual(mock.rpcCalls[0].args.p_promotions, [{
    id: "emp-excel-inactivo",
    prior_external_workera_id: "EXCEL-INACTIVO",
    external_workera_id: "WORKERA-REACTIVADO",
    prior_active: false,
    prior_updated_at: "2026-09-07T12:00:00.000Z",
    active: true,
  }]);
});

test("bootstrapEmployeesFromRoster: una ficha local_provisional con nombre completo exacto se promueve sobre la misma fila", async () => {
  const mock = createMockSupabase([{ id: "emp-local-1", external_workera_id: "LOCAL-PROVISIONAL:PERSONA", source: "local_provisional", first_name: "PERSONA", last_name: "CONFIRMADA" }]);
  const client = fakeWorkeraClient([{ code: "WORKERA-OFICIAL", firstName: "PERSONA", lastName: "CONFIRMADA" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.promotedFromExcelRoster, 1);
  assert.equal(result.newlyBootstrapped, 0);
  assert.equal(mock.inserted.length, 0);
  assert.deepEqual(mock.updated, [{ filters: [{ column: "company_id", value: TEST_COMPANY_ID }, { column: "id", value: "emp-local-1" }], patch: { external_workera_id: "WORKERA-OFICIAL", source: "workera", active: true } }]);
});

test("bootstrapEmployeesFromRoster: un INACTIVO nunca desactiva una ficha administrativa vinculada sólo por nombre", async () => {
  const mock = createMockSupabase([{
    id: "00000000-0000-4000-8000-000000000091",
    external_workera_id: "EXCEL-11111111-1",
    source: "excel_roster",
    first_name: "NOMBRE",
    last_name: "COMPARTIDO",
    active: true,
  }]);
  const client = fakeWorkeraClient([{
    code: "WORKERA-INACTIVO",
    firstName: "NOMBRE",
    lastName: "COMPARTIDO",
    employeeStatus: "INACTIVO",
  }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.promotedToWorkera, 0);
  assert.equal(result.newlyBootstrapped, 1, "conserva la identidad oficial como fila inactiva separada hasta revisión");
  assert.equal(result.reconciliationRequired.length, 1);
  assert.equal(mock.updated.length, 0, "la coincidencia débil por nombre nunca cambia la vigencia administrativa");
  assert.equal(mock.inserted[0].active, false);
});

test("bootstrapEmployeesFromRoster: una promoción con estado desconocido se bloquea sin alterar la ficha administrativa", async () => {
  const mock = createMockSupabase([{ id: "emp-excel-unknown", external_workera_id: "EXCEL-TEMP", source: "excel_roster", first_name: "ESTADO", last_name: "PENDIENTE", active: false }]);
  const client = fakeWorkeraClient([{ code: "WORKERA-UNKNOWN", firstName: "ESTADO", lastName: "PENDIENTE", employeeStatus: "NO_DOCUMENTADO" }]);

  await assert.rejects(
    () => bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID),
    /estado\(s\).*no reconocido/,
  );
  assert.equal(mock.updated.length, 0);
  assert.equal(mock.rpcCalls.length, 0);
});

test("bootstrapEmployeesFromRoster: nombre coincide con DOS empleados excel_roster -> nunca elige uno al azar, inserta fila nueva y marca reconciliationRequired", async () => {
  const mock = createMockSupabase([
    { id: "emp-excel-1", external_workera_id: "EXCEL-11111111-1", source: "excel_roster", first_name: "PEDRO", last_name: "GOMEZ" },
    { id: "emp-excel-2", external_workera_id: "EXCEL-22222222-2", source: "excel_roster", first_name: "PEDRO", last_name: "GOMEZ" },
  ]);
  const client = fakeWorkeraClient([{ code: "90000301", firstName: "PEDRO", lastName: "GOMEZ" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.newlyBootstrapped, 1, "se crea una fila nueva para no perder al empleado real de Workera");
  assert.equal(mock.updated.length, 0, "nunca promueve automáticamente cuando hay ambigüedad");
  assert.equal(result.reconciliationRequired.length, 1);
  assert.equal(result.reconciliationRequired[0].rosterCode, "90000301");
  assert.equal(result.reconciliationRequired[0].matchedNames.length, 2);
});

test("bootstrapEmployeesFromRoster: nunca reconcilia por nombre contra un empleado ya source='workera' (solo excel_roster sin vincular es candidato)", async () => {
  const mock = createMockSupabase([{ id: "emp-workera-1", external_workera_id: "90000400", source: "workera", first_name: "LUIS", last_name: "TORRES" }]);
  const client = fakeWorkeraClient([{ code: "90000401", firstName: "LUIS", lastName: "TORRES" }]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.newlyBootstrapped, 1, "un código nuevo de Workera nunca se fusiona contra otro empleado ya confirmado por Workera, aunque el nombre coincida");
  assert.equal(mock.updated.length, 0);
});

test("bootstrapEmployeesFromRoster: un homónimo remoto ya vinculado vuelve ambiguo el nombre y bloquea la promoción", async () => {
  const mock = createMockSupabase([
    {
      id: "emp-workera-vinculado",
      external_workera_id: "WORKERA-YA-VINCULADO",
      source: "workera",
      first_name: "NOMBRE",
      last_name: "COMPARTIDO",
      active: true,
    },
    {
      id: "emp-excel-candidato",
      external_workera_id: "EXCEL-CANDIDATO",
      source: "excel_roster",
      first_name: "NOMBRE",
      last_name: "COMPARTIDO",
      active: true,
    },
  ]);
  const client = fakeWorkeraClient([
    { code: "WORKERA-YA-VINCULADO", firstName: "NOMBRE", lastName: "COMPARTIDO" },
    { code: "WORKERA-NUEVO-HOMONIMO", firstName: "NOMBRE", lastName: "COMPARTIDO" },
  ]);

  const result = await bootstrapEmployeesFromRoster(mock as never, client, TEST_COMPANY_ID);

  assert.equal(result.alreadyExisting, 1);
  assert.equal(result.promotedToWorkera, 0, "la unicidad se calcula sobre todo el roster remoto, no sólo códigos nuevos");
  assert.equal(result.newlyBootstrapped, 1);
  assert.equal(result.reconciliationRequired.length, 1);
  assert.equal(mock.updated.length, 0);
});

// -----------------------------------------------------------------------------
// resolveEmployeeByFullName

test("resolveEmployeeByFullName: exactamente 1 coincidencia normalizada -> resolved", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "MICHEL", last_name: "MENDY" }]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy", TEST_COMPANY_ID);
  assert.equal(result.resolved, true);
  assert.equal(result.employeeId, "emp-1");
});

test("resolveEmployeeByFullName: coincide ignorando acentos/mayúsculas/espacios", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "CLAUDIO ANDRES", last_name: "BARRERA" }]);
  const result = await resolveEmployeeByFullName(mock as never, "  claudio   andrés   barrera  ", TEST_COMPANY_ID);
  assert.equal(result.resolved, true);
});

test("resolveEmployeeByFullName: 0 coincidencias -> unresolved, nunca se adivina", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "OTRO", last_name: "NOMBRE" }]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy", TEST_COMPANY_ID);
  assert.equal(result.resolved, false);
  assert.equal(result.matchCount, 0);
  assert.equal(result.employeeId, null);
});

test("resolveEmployeeByFullName: 2+ coincidencias -> unresolved, nunca se elige uno al azar", async () => {
  const mock = createMockSupabase([
    { id: "emp-1", first_name: "MICHEL", last_name: "MENDY" },
    { id: "emp-2", first_name: "MICHEL", last_name: "MENDY" },
  ]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy", TEST_COMPANY_ID);
  assert.equal(result.resolved, false);
  assert.equal(result.matchCount, 2);
});

test("resolveEmployeeByFullName: nombre parcial NO es suficiente (nunca fuzzy) -- segundo nombre no coincidente no matchea", async () => {
  const mock = createMockSupabase([{ id: "emp-1", first_name: "MICHEL ALEXANDER", last_name: "MENDY" }]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy", TEST_COMPANY_ID);
  assert.equal(result.resolved, false, "un segundo nombre real que el buscador no conoce nunca debe producir un match automático");
});

test("resolveEmployeeByFullName: sourceEquals acota la búsqueda -- nunca reconcilia contra alguien de otra fuente", async () => {
  const mock = createMockSupabase([
    { id: "emp-1", first_name: "MICHEL", last_name: "MENDY", source: "workera" },
    { id: "emp-2", first_name: "OTRO", last_name: "NOMBRE", source: "excel_roster" },
  ]);
  const result = await resolveEmployeeByFullName(mock as never, "Michel Mendy", TEST_COMPANY_ID, { sourceEquals: "excel_roster" });
  assert.equal(result.resolved, false, "aunque el nombre existe, está en source='workera', no en el filtro solicitado");
});
