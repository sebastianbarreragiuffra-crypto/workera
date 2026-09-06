import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDIO_BARRERA_PROVISIONAL_CODE,
  ensureClaudioBarreraProvisional,
  isLocalProvisionalCode,
  reconcileLocalProvisionalEmployee,
} from "./local-provisional-employee";

interface Row extends Record<string, unknown> {
  id: string;
}

function memorySupabase() {
  const tables: Record<string, Row[]> = {
    employee_groups: [{ id: "group-admin", company_id: "company", code: "ADMINISTRATION" }],
    employees: [],
  };
  let nextId = 1;

  class Query {
    private operation: "select" | "insert" | "update" = "select";
    private payload: Record<string, unknown> | null = null;
    private filters: Array<{ column: string; value: unknown; negate: boolean }> = [];

    constructor(private readonly table: string) {}
    select() { return this; }
    eq(column: string, value: unknown) { this.filters.push({ column, value, negate: false }); return this; }
    neq(column: string, value: unknown) { this.filters.push({ column, value, negate: true }); return this; }
    insert(payload: Record<string, unknown>) { this.operation = "insert"; this.payload = payload; return this; }
    update(payload: Record<string, unknown>) { this.operation = "update"; this.payload = payload; return this; }

    private matches(row: Row): boolean {
      return this.filters.every((filter) => filter.negate ? row[filter.column] !== filter.value : row[filter.column] === filter.value);
    }

    private execute(): Row[] {
      const rows = tables[this.table];
      if (!rows) throw new Error(`Tabla inesperada ${this.table}`);
      if (this.operation === "insert") {
        if (rows.some((row) => row.company_id === this.payload?.company_id && row.external_workera_id === this.payload?.external_workera_id)) {
          return [];
        }
        const created = { id: `created-${nextId++}`, ...this.payload } as Row;
        rows.push(created);
        return [created];
      }
      const matching = rows.filter((row) => this.matches(row));
      if (this.operation === "update" && this.payload) matching.forEach((row) => Object.assign(row, this.payload));
      return matching;
    }

    maybeSingle() {
      const rows = this.execute();
      return Promise.resolve({ data: rows.length === 1 ? rows[0] : null, error: null });
    }

    single() {
      const rows = this.execute();
      return Promise.resolve({ data: rows.length === 1 ? rows[0] : null, error: rows.length === 1 ? null : { message: "expected one row" } });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = { from: (table: string) => new Query(table) };
  return { client, tables };
}

test("ficha local Claudio: usa una clave inequívocamente provisional y la creación es idempotente", async () => {
  const { client, tables } = memorySupabase();

  const first = await ensureClaudioBarreraProvisional(client, "company");
  const second = await ensureClaudioBarreraProvisional(client, "company");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.employeeId, second.employeeId);
  assert.equal(tables.employees.length, 1);
  assert.equal(tables.employees[0].active, true);
  assert.equal(tables.employees[0].source, "local_provisional");
  assert.equal(tables.employees[0].rut, null);
  assert.equal(tables.employees[0].external_workera_id, CLAUDIO_BARRERA_PROVISIONAL_CODE);
  assert.equal(isLocalProvisionalCode(CLAUDIO_BARRERA_PROVISIONAL_CODE), true);
  assert.equal(isLocalProvisionalCode("12696643"), false);
});

test("ficha local Claudio: se promueve sobre la misma fila al recibir código oficial y no crea duplicados", async () => {
  const { client, tables } = memorySupabase();
  const provisional = await ensureClaudioBarreraProvisional(client, "company");

  const result = await reconcileLocalProvisionalEmployee(client, {
    companyId: "company",
    employeeId: provisional.employeeId,
    officialWorkeraId: "WORKERA-OFICIAL-1",
    rut: "11111111-1",
  });
  const repeated = await reconcileLocalProvisionalEmployee(client, {
    companyId: "company",
    employeeId: provisional.employeeId,
    officialWorkeraId: "WORKERA-OFICIAL-1",
    rut: "11111111-1",
  });

  assert.equal(result.reconciled, true);
  assert.equal(repeated.reconciled, false);
  assert.equal(tables.employees.length, 1);
  assert.equal(tables.employees[0].id, provisional.employeeId);
  assert.equal(tables.employees[0].source, "workera");
  assert.equal(tables.employees[0].external_workera_id, "WORKERA-OFICIAL-1");
  assert.equal(tables.employees[0].rut, "11111111-1");
});

test("reconciliación provisional: rechaza usar otra clave temporal como si fuera código Workera", async () => {
  const { client } = memorySupabase();
  const provisional = await ensureClaudioBarreraProvisional(client, "company");

  await assert.rejects(
    () => reconcileLocalProvisionalEmployee(client, {
      companyId: "company",
      employeeId: provisional.employeeId,
      officialWorkeraId: "LOCAL-PROVISIONAL:OTRA-CLAVE",
    }),
    /código Workera oficial/,
  );
});

test("reconciliación provisional: un código oficial ya usado bloquea la promoción y nunca crea otra persona", async () => {
  const { client, tables } = memorySupabase();
  const provisional = await ensureClaudioBarreraProvisional(client, "company");
  tables.employees.push({
    id: "official-existing",
    company_id: "company",
    external_workera_id: "WORKERA-OCUPADO",
    source: "workera",
  });

  const result = await reconcileLocalProvisionalEmployee(client, {
    companyId: "company",
    employeeId: provisional.employeeId,
    officialWorkeraId: "WORKERA-OCUPADO",
  });

  assert.equal(result.reconciled, false);
  assert.equal(result.conflictEmployeeId, "official-existing");
  assert.equal(tables.employees.length, 2);
  assert.equal(tables.employees.find((row) => row.id === provisional.employeeId)?.source, "local_provisional");
});

test("reconciliación provisional: un RUT ya usado también bloquea y una segunda identidad oficial no sobrescribe la conciliación", async () => {
  const { client, tables } = memorySupabase();
  const provisional = await ensureClaudioBarreraProvisional(client, "company");
  tables.employees.push({
    id: "rut-existing",
    company_id: "company",
    external_workera_id: "WORKERA-OTRO",
    rut: "22222222-2",
    source: "workera",
  });

  const conflict = await reconcileLocalProvisionalEmployee(client, {
    companyId: "company",
    employeeId: provisional.employeeId,
    officialWorkeraId: "WORKERA-NUEVO",
    rut: "22222222-2",
  });
  assert.equal(conflict.conflictEmployeeId, "rut-existing");

  const reconciled = await reconcileLocalProvisionalEmployee(client, {
    companyId: "company",
    employeeId: provisional.employeeId,
    officialWorkeraId: "WORKERA-CORRECTO",
    rut: "33333333-3",
  });
  assert.equal(reconciled.reconciled, true);
  await assert.rejects(
    () => reconcileLocalProvisionalEmployee(client, {
      companyId: "company",
      employeeId: provisional.employeeId,
      officialWorkeraId: "WORKERA-DISTINTO",
      rut: "33333333-3",
    }),
    /otra identidad oficial/,
  );
});
