import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parsePersonnelRosterExcel, computePersonnelRosterPreview, applyPersonnelRosterImport, normalizeEmployeeRut } from "./personnel-roster-import";

const HEADER = ["N°", "FECHA DE INGRESO", "APELLIDOS", "NOMBRES", "R.U.T.", "CARGO", "FECHA DE NACIMIENTO"];
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function buildWorkbookBytes(rows: (string | number | Date | null)[][], sheetName = "Hoja1"): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

function row(n: number, apellidos: string, nombres: string, rut: string, cargo: string, ingreso: Date | null = null, nacimiento: Date | null = null): (string | number | Date | null)[] {
  return [n, ingreso, apellidos, nombres, rut, cargo, nacimiento];
}

// ---------------------------------------------------------------------------
// Parsing / estructura (44 filas, mismo formato real confirmado, datos ficticios)
test("parsePersonnelRosterExcel: parsea 44 filas ficticias con el formato real confirmado (N° / FECHA DE INGRESO / APELLIDOS / NOMBRES / R.U.T. / CARGO / FECHA DE NACIMIENTO)", () => {
  const rows = Array.from({ length: 44 }, (_, i) =>
    row(i + 1, `APELLIDO${i}`, `NOMBRE${i}`, `${10000000 + i}-${i % 10}`, i % 3 === 0 ? "OPERARIO DE PRODUCCION" : i % 3 === 1 ? "INSTALACION" : "ADMINISTRATIVO", new Date(2020, 0, 1), new Date(1990, 0, 1))
  );
  const result = parsePersonnelRosterExcel(buildWorkbookBytes(rows));
  assert.equal(result.valid.length, 44);
  assert.equal(result.issues.length, 0);
  assert.equal(result.duplicateRutConflicts.length, 0);
});

test("parsePersonnelRosterExcel: detecta el encabezado aunque no esté en la primera hoja", () => {
  const junkSheet = XLSX.utils.aoa_to_sheet([["algo", "irrelevante"]]);
  const realSheet = XLSX.utils.aoa_to_sheet([HEADER, row(1, "PEREZ", "JUAN", "11111111-1", "ADMINISTRATIVO")]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, junkSheet, "Portada");
  XLSX.utils.book_append_sheet(workbook, realSheet, "Personal");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;

  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.valid.length, 1);
});

test("parsePersonnelRosterExcel: sin encabezado reconocible -> HEADER_NOT_FOUND", () => {
  const bytes = buildWorkbookBytes([]);
  const sheet = XLSX.utils.aoa_to_sheet([["columna random"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  const badBytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
  void bytes;

  const result = parsePersonnelRosterExcel(badBytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "HEADER_NOT_FOUND");
});

test("parsePersonnelRosterExcel: fila sin RUT/apellido/nombre -> MISSING_FIELD, no bloquea el resto", () => {
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11111111-1", "ADMINISTRATIVO"), row(2, "", "MARIA", "22222222-2", "ADMINISTRATIVO")]);
  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].reason, "MISSING_FIELD");
});

test("parsePersonnelRosterExcel: RUT con formato irreconocible -> INVALID_RUT", () => {
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "no-es-un-rut", "ADMINISTRATIVO")]);
  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.valid.length, 0);
  assert.equal(result.issues[0].reason, "INVALID_RUT");
});

test("parsePersonnelRosterExcel: RUT duplicado dentro del archivo con datos idénticos -> se deduplica, no es error", () => {
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO"), row(2, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO")]);
  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.duplicateRutConflicts.length, 0);
});

test("parsePersonnelRosterExcel: RUT duplicado con datos distintos -> conflicto, nunca se elige uno en silencio", () => {
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO"), row(2, "GOMEZ", "ANA", "11.111.111-1", "INSTALACION")]);
  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.duplicateRutConflicts.length, 1);
  assert.deepEqual(result.duplicateRutConflicts[0].rows, [2, 3]);
});

test("parsePersonnelRosterExcel: un RUT repetido con fechas distintas también es conflicto", () => {
  const bytes = buildWorkbookBytes([
    row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO", new Date(2021, 0, 1), new Date(1990, 0, 1)),
    row(2, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO", new Date(2021, 0, 1), new Date(1991, 0, 1)),
  ]);

  const result = parsePersonnelRosterExcel(bytes);

  assert.equal(result.valid.length, 0);
  assert.deepEqual(result.duplicateRutConflicts, [{ rut: "11111111-1", rows: [2, 3] }]);
});

test("parsePersonnelRosterExcel: cargo no catalogado -> groupCode null (SIN_ASIGNAR), la fila sigue siendo válida", () => {
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "PREVENCIONISTA DE RIESGOS")]);
  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].groupCode, null);
});

test("parsePersonnelRosterExcel: convierte fechas de Excel a ISO correctamente", () => {
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO", new Date(2021, 2, 1), new Date(1980, 9, 28))]);
  const result = parsePersonnelRosterExcel(bytes);
  assert.equal(result.valid[0].hireDate, "2021-03-01");
  assert.equal(result.valid[0].birthDate, "1980-10-28");
});

test("normalizeEmployeeRut: normaliza formatos reales al formato exigido por el CHECK constraint de employees.rut", () => {
  assert.equal(normalizeEmployeeRut("22.638.644-0"), "22638644-0");
  assert.equal(normalizeEmployeeRut("13864537-1"), "13864537-1");
  assert.equal(normalizeEmployeeRut("8.509.295-2"), "8509295-2");
  assert.equal(normalizeEmployeeRut("no es un rut"), null);
});

// ---------------------------------------------------------------------------
// Preview / apply (mock de Supabase)
interface FakeEmployeeRow {
  id: string;
  rut: string | null;
  active: boolean;
  source: string;
  display_name: string;
  first_name: string;
  last_name: string;
  employee_group_id: string | null;
  hire_date: string | null;
  updated_at?: string;
  company_id?: string;
}

function mockSupabase(opts: {
  groups?: { id: string; code: string; company_id?: string }[];
  employees?: FakeEmployeeRow[];
  birthdays?: { employee_id: string; birth_month: number; birth_day: number; company_id?: string }[];
} = {}) {
  const groups = (opts.groups ?? [
    { id: "group-production", code: "PRODUCTION" },
    { id: "group-installation", code: "INSTALLATION" },
    { id: "group-administration", code: "ADMINISTRATION" },
  ]).map((group) => ({ ...group, company_id: group.company_id ?? COMPANY_ID }));
  const employees = (opts.employees ?? []).map((employee) => ({
    ...employee,
    updated_at: employee.updated_at ?? "2026-09-07T12:00:00.000Z",
    company_id: employee.company_id ?? COMPANY_ID,
  }));
  const birthdays = (opts.birthdays ?? []).map((birthday) => ({
    ...birthday,
    company_id: birthday.company_id ?? COMPANY_ID,
  }));
  const rpcCalls: { name: string; args: unknown }[] = [];
  const scopedReads: { table: string; column: string; value: string }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === "employee_groups") {
        return {
          select: () => ({
            eq(column: string, value: string) {
              scopedReads.push({ table, column, value });
              return Promise.resolve({ data: groups.filter((group) => group.company_id === value), error: null });
            },
          }),
        };
      }
      if (table === "employees") {
        return {
          select: () => ({
            eq(column: string, value: string) {
              scopedReads.push({ table, column, value });
              return Promise.resolve({ data: employees.filter((employee) => employee.company_id === value), error: null });
            },
          }),
        };
      }
      if (table === "employee_birthdays") {
        return {
          select: () => ({
            eq(column: string, value: string) {
              scopedReads.push({ table, column, value });
              return Promise.resolve({ data: birthdays.filter((birthday) => birthday.company_id === value), error: null });
            },
          }),
        };
      }
      throw new Error(`mockSupabase: tabla no soportada: ${table}`);
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      const payload = args as {
        p_confirmed_ruts?: string[];
        p_insert_rows?: unknown[];
        p_update_rows?: Record<string, unknown>[];
        p_deactivate_ids?: unknown[];
      };
      const updateRows = payload.p_update_rows ?? [];
      const changedUpdateRows = updateRows.filter((item) => {
        const employee = employees.find((candidate) => candidate.id === item.id);
        if (!employee) return true;
        const targetGroupId = item.employee_group_id === "" ? null : item.employee_group_id;
        const targetHireDate = item.hire_date === "" ? null : item.hire_date;
        const targetActive = item.reactivate === "true" ? true : item.prior_active;
        if (employee.employee_group_id !== targetGroupId || employee.hire_date !== targetHireDate || employee.active !== targetActive) return true;
        if ("first_name" in item && (
          employee.first_name !== item.first_name ||
          employee.last_name !== item.last_name ||
          employee.display_name !== item.display_name
        )) return true;
        if ("birth_month" in item) {
          const birthday = birthdays.find((candidate) => candidate.employee_id === employee.id);
          if (!birthday || birthday.birth_month !== Number(item.birth_month) || birthday.birth_day !== Number(item.birth_day)) return true;
        }
        return false;
      });
      return Promise.resolve({
        data: {
          inserted_count: payload.p_insert_rows?.length ?? 0,
          updated_count: changedUpdateRows.filter((item) => item.reactivate !== "true").length,
          reactivated_count: changedUpdateRows.filter((item) => item.reactivate === "true").length,
          deactivated_count: payload.p_deactivate_ids?.length ?? 0,
        },
        error: null,
      });
    },
  };

  return { client, rpcCalls, scopedReads };
}

test("computePersonnelRosterPreview: base vacía -> todo NEW", async () => {
  const { client } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.ok, true);
  assert.equal(preview.newCount, 1);
  assert.equal(preview.rows[0].status, "NEW");
});

test("computePersonnelRosterPreview: mismo RUT, mismos datos -> UNCHANGED", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.unchangedCount, 1);
});

test("computePersonnelRosterPreview: mismo RUT, grupo distinto -> UPDATED", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-installation", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.updatedCount, 1);
});

test("computePersonnelRosterPreview: mismo RUT, empleado excel_roster inactivo -> REACTIVATED", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: false, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.reactivatedCount, 1);
});

test("computePersonnelRosterPreview: workera inactivo sin cambios -> UNCHANGED y conserva la baja", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: false, source: "workera", display_name: "NOMBRE WORKERA", first_name: "NOMBRE", last_name: "WORKERA", employee_group_id: "group-production", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.rows[0].status, "UNCHANGED");
  assert.equal(preview.rows[0].existingSource, "workera");
  assert.equal(preview.unchangedCount, 1);
  assert.equal(preview.reactivatedCount, 0);
});

test("computePersonnelRosterPreview: workera inactivo con metadatos administrativos distintos -> UPDATED, nunca REACTIVATED", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: false, source: "workera", display_name: "NOMBRE WORKERA", first_name: "NOMBRE", last_name: "WORKERA", employee_group_id: "group-installation", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.rows[0].status, "UPDATED");
  assert.equal(preview.updatedCount, 1);
  assert.equal(preview.reactivatedCount, 0);
});

test("computePersonnelRosterPreview: local_provisional inactivo queda fail-closed y no se reactiva desde Excel", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: false, source: "local_provisional", display_name: "PROVISIONAL", first_name: "NOMBRE", last_name: "PROVISIONAL", employee_group_id: "group-production", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.rows[0].status, "UNCHANGED");
  assert.equal(preview.rows[0].existingSource, "local_provisional");
  assert.equal(preview.reactivatedCount, 0);
});

test("computePersonnelRosterPreview: una fuente no admitida bloquea el plan antes del RPC", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e-demo", rut: "11111111-1", active: true, source: "demo", display_name: "PERSONA DEMO", first_name: "PERSONA", last_name: "DEMO", employee_group_id: "group-installation", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.ok, false);
  assert.match(preview.blockingError ?? "", /fuente no puede ser reconciliada/);
  assert.equal(preview.problemCount, 1);
  assert.deepEqual(preview.rows, []);
  assert.deepEqual(rpcCalls, []);
});

test("applyPersonnelRosterImport: una fuente no admitida falla cerrado sin invocar el RPC", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e-demo", rut: "11111111-1", active: true, source: "demo", display_name: "PERSONA DEMO", first_name: "PERSONA", last_name: "DEMO", employee_group_id: "group-installation", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  await assert.rejects(
    () => applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID }),
    /fuente no puede ser reconciliada/,
  );
  assert.deepEqual(rpcCalls, []);
});

test("computePersonnelRosterPreview: rechaza companyId ausente antes de consultar datos", async () => {
  const { client, scopedReads } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  await assert.rejects(() => computePersonnelRosterPreview(client, bytes, ""), /requiere una empresa válida/);
  assert.deepEqual(scopedReads, []);
});

test("computePersonnelRosterPreview: limita grupos y empleados a company_id", async () => {
  const { client, scopedReads } = mockSupabase({
    groups: [
      { id: "group-own-production", code: "PRODUCTION", company_id: COMPANY_ID },
      { id: "group-other-production", code: "PRODUCTION", company_id: OTHER_COMPANY_ID },
    ],
    employees: [
      { id: "other-e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "OTRO TENANT", first_name: "OTRO", last_name: "TENANT", employee_group_id: "group-other-production", hire_date: null, company_id: OTHER_COMPANY_ID },
    ],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.rows[0].status, "NEW", "un RUT de otra empresa no se puede reconciliar con el tenant activo");
  assert.deepEqual(scopedReads, [
    { table: "employee_groups", column: "company_id", value: COMPANY_ID },
    { table: "employees", column: "company_id", value: COMPANY_ID },
    { table: "employee_birthdays", column: "employees.company_id", value: COMPANY_ID },
  ]);
});

test("computePersonnelRosterPreview: empleado activo (excel_roster) ausente del archivo confirmado -> SE_DESACTIVARA", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "99999999-9", active: true, source: "excel_roster", display_name: "AUSENTE HOY", first_name: "AUSENTE", last_name: "HOY", employee_group_id: null, hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.toDeactivateCount, 1);
  assert.equal(preview.toDeactivate[0].employeeId, "e1");
});

test("computePersonnelRosterPreview: un empleado source='workera' activo pero ausente del archivo NUNCA se marca para desactivar (Excel no tiene autoridad sobre empleados confirmados por Workera)", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "99999999-9", active: true, source: "workera", display_name: "CONFIRMADO WORKERA", first_name: "CONFIRMADO", last_name: "WORKERA", employee_group_id: null, hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.toDeactivateCount, 0);
});

test("computePersonnelRosterPreview: cargo sin mapeo -> unassignedCount cuenta la fila", async () => {
  const { client } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "PREVENCIONISTA DE RIESGOS")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.unassignedCount, 1);
});

test("computePersonnelRosterPreview: RUT duplicado con datos distintos bloquea todo el archivo (ok=false)", async () => {
  const { client } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO"), row(2, "GOMEZ", "ANA", "11.111.111-1", "INSTALACION")]);
  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);
  assert.equal(preview.ok, false);
});

test("computePersonnelRosterPreview: una fila inválida bloquea todo el archivo y nunca propone bajas", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e-protected", rut: "22222222-2", active: true, source: "excel_roster", display_name: "MARIA EXISTENTE", first_name: "MARIA", last_name: "EXISTENTE", employee_group_id: null, hire_date: null }],
  });
  const bytes = buildWorkbookBytes([
    row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO"),
    row(2, "", "MARIA", "22.222.222-2", "ADMINISTRATIVO"),
  ]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.ok, false);
  assert.match(preview.blockingError ?? "", /campos obligatorios ausentes o RUT inválido/);
  assert.equal(preview.problemCount, 1);
  assert.equal(preview.toDeactivateCount, 0);
  assert.deepEqual(preview.toDeactivate, []);
});

test("applyPersonnelRosterImport: una fila inválida falla cerrado sin invocar el RPC", async () => {
  const { client, rpcCalls } = mockSupabase();
  const bytes = buildWorkbookBytes([
    row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO"),
    row(2, "", "MARIA", "22.222.222-2", "ADMINISTRATIVO"),
  ]);

  await assert.rejects(
    () => applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID }),
    /campos obligatorios ausentes o RUT inválido/,
  );
  assert.deepEqual(rpcCalls, []);
});

test("applyPersonnelRosterImport: una planilla vacía nunca desactiva todo el padrón", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e-protected", rut: "22222222-2", active: true, source: "excel_roster", display_name: "MARIA EXISTENTE", first_name: "MARIA", last_name: "EXISTENTE", employee_group_id: null, hire_date: null }],
  });
  const bytes = buildWorkbookBytes([]);

  await assert.rejects(
    () => applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID }),
    /no contiene ninguna fila válida/,
  );
  assert.deepEqual(rpcCalls, []);
});

test("applyPersonnelRosterImport: llama a la función atómica con tenant/insert/update/deactivate ya resueltos, nunca hace DELETE", async () => {
  const { client, rpcCalls, scopedReads } = mockSupabase({
    employees: [
      { id: "e-update", rut: "22222222-2", active: true, source: "excel_roster", display_name: "OLD NAME", first_name: "OLD", last_name: "NAME", employee_group_id: "group-installation", hire_date: null },
      { id: "e-deactivate", rut: "33333333-3", active: true, source: "excel_roster", display_name: "SE VA", first_name: "SE", last_name: "VA", employee_group_id: null, hire_date: null },
    ],
  });
  const bytes = buildWorkbookBytes([
    row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION"),
    row(2, "GOMEZ", "ANA", "22.222.222-2", "INSTALACION"),
  ]);

  const result = await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  assert.equal(result.insertedCount, 1);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.deactivatedCount, 1);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, "apply_personnel_roster_import");
  const args = rpcCalls[0].args as { p_company_id: string; p_confirmed_ruts: string[]; p_insert_rows: unknown[]; p_update_rows: Record<string, unknown>[]; p_deactivate_ids: Record<string, unknown>[] };
  assert.equal(args.p_company_id, COMPANY_ID);
  assert.deepEqual(args.p_confirmed_ruts, ["11111111-1", "22222222-2"]);
  assert.equal(args.p_insert_rows.length, 1);
  assert.equal(args.p_update_rows.length, 1);
  assert.deepEqual(args.p_deactivate_ids, [{
    id: "e-deactivate",
    prior_rut: "33333333-3",
    prior_source: "excel_roster",
    prior_active: true,
    prior_updated_at: "2026-09-07T12:00:00.000Z",
  }]);
  assert.equal(args.p_update_rows[0].prior_active, true);
  assert.equal(args.p_update_rows[0].prior_source, "excel_roster");
  assert.equal(args.p_update_rows[0].prior_updated_at, "2026-09-07T12:00:00.000Z");
  assert.equal(scopedReads.length, 3, "apply construye todo el plan desde un único contexto del tenant");
  assert.ok(scopedReads.every((read) => read.value === COMPANY_ID));
  // "nunca hace DELETE" -- el mock ni siquiera define un método delete; si el código lo llamara, la prueba fallaría con "is not a function".
});

test("applyPersonnelRosterImport: para un empleado ya source='workera', el update NUNCA incluye first_name/last_name/display_name (precedencia de identidad)", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e-workera", rut: "11111111-1", active: true, source: "workera", display_name: "NOMBRE WORKERA CONFIRMADO", first_name: "NOMBRE", last_name: "WORKERA CONFIRMADO", employee_group_id: null, hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "APELLIDO EXCEL DISTINTO", "NOMBRE EXCEL DISTINTO", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_update_rows: Record<string, unknown>[] };
  assert.equal(args.p_update_rows.length, 1);
  assert.ok(!("first_name" in args.p_update_rows[0]), "un empleado ya confirmado por Workera nunca debe recibir el nombre desde Excel");
  assert.ok(!("last_name" in args.p_update_rows[0]));
  assert.ok(!("display_name" in args.p_update_rows[0]));
  assert.equal(args.p_update_rows[0].employee_group_id, "group-production", "el grupo SÍ puede actualizarse -- Workera no provee esa información administrativa");
});

test("applyPersonnelRosterImport: sólo excel_roster inactivo recibe reactivate='true'", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e-excel", rut: "11111111-1", active: false, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const result = await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_update_rows: Record<string, unknown>[] };
  assert.equal(result.reactivatedCount, 1);
  assert.equal(args.p_update_rows.length, 1);
  assert.equal(args.p_update_rows[0].reactivate, "true");
});

test("applyPersonnelRosterImport: workera/local_provisional inactivos pueden actualizar metadatos pero nunca reciben reactivate", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [
      { id: "e-workera", rut: "11111111-1", active: false, source: "workera", display_name: "IDENTIDAD WORKERA", first_name: "IDENTIDAD", last_name: "WORKERA", employee_group_id: "group-installation", hire_date: null },
      { id: "e-provisional", rut: "22222222-2", active: false, source: "local_provisional", display_name: "IDENTIDAD PROVISIONAL", first_name: "IDENTIDAD", last_name: "PROVISIONAL", employee_group_id: "group-installation", hire_date: null },
    ],
  });
  const bytes = buildWorkbookBytes([
    row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION"),
    row(2, "GOMEZ", "ANA", "22.222.222-2", "OPERARIO DE PRODUCCION"),
  ]);

  const result = await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_update_rows: Record<string, unknown>[] };
  assert.equal(result.updatedCount, 2);
  assert.equal(result.reactivatedCount, 0);
  assert.equal(args.p_update_rows.length, 2);
  assert.ok(args.p_update_rows.every((update) => !("reactivate" in update)));
});

test("applyPersonnelRosterImport: filas UNCHANGED viajan como precondición del padrón completo, sin contarse como escritura", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const result = await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_confirmed_ruts: string[]; p_insert_rows: unknown[]; p_update_rows: Record<string, unknown>[] };
  assert.equal(args.p_insert_rows.length, 0);
  assert.deepEqual(args.p_confirmed_ruts, ["11111111-1"]);
  assert.equal(args.p_update_rows.length, 1);
  assert.equal(args.p_update_rows[0].id, "e1");
  assert.equal(result.updatedCount, 0);
});

test("computePersonnelRosterPreview: un cambio sólo de cumpleaños se marca UPDATED", async () => {
  const { client } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
    birthdays: [{ employee_id: "e1", birth_month: 5, birth_day: 14 }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION", null, new Date(1990, 4, 15))]);

  const preview = await computePersonnelRosterPreview(client, bytes, COMPANY_ID);

  assert.equal(preview.ok, true);
  assert.equal(preview.updatedCount, 1);
  assert.equal(preview.rows[0].status, "UPDATED");
});

test("applyPersonnelRosterImport: cumpleaños existente usa precondición y actualiza sólo mes/día", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
    birthdays: [{ employee_id: "e1", birth_month: 5, birth_day: 14 }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION", null, new Date(1990, 4, 15))]);

  const result = await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_update_rows: Record<string, unknown>[] };
  assert.equal(result.updatedCount, 1);
  assert.equal(args.p_update_rows[0].birth_month, "5");
  assert.equal(args.p_update_rows[0].birth_day, "15");
  assert.equal(args.p_update_rows[0].prior_birth_month, "5");
  assert.equal(args.p_update_rows[0].prior_birth_day, "14");
});

test("applyPersonnelRosterImport: cumpleaños vacío conserva el valor existente", async () => {
  const { client, rpcCalls } = mockSupabase({
    employees: [{ id: "e1", rut: "11111111-1", active: true, source: "excel_roster", display_name: "JUAN PEREZ", first_name: "JUAN", last_name: "PEREZ", employee_group_id: "group-production", hire_date: null }],
    birthdays: [{ employee_id: "e1", birth_month: 5, birth_day: 14 }],
  });
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  const result = await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_update_rows: Record<string, unknown>[] };
  assert.equal(result.updatedCount, 0);
  assert.equal(args.p_update_rows.length, 1);
  assert.ok(!("birth_month" in args.p_update_rows[0]));
  assert.ok(!("prior_birth_month" in args.p_update_rows[0]));
});

test("applyPersonnelRosterImport: fila con fecha de nacimiento incluye birth_month/birth_day para la reconciliación de cumpleaños", async () => {
  const { client, rpcCalls } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION", null, new Date(1990, 4, 15))]);

  await applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID });

  const args = rpcCalls[0].args as { p_insert_rows: Record<string, unknown>[] };
  assert.equal(args.p_insert_rows[0].birth_month, "5");
  assert.equal(args.p_insert_rows[0].birth_day, "15");
});

test("applyPersonnelRosterImport: si el archivo no pasa la validación, nunca llega a llamar la función atómica", async () => {
  const { client, rpcCalls } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "ADMINISTRATIVO"), row(2, "GOMEZ", "ANA", "11.111.111-1", "INSTALACION")]);

  await assert.rejects(() =>
    applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: COMPANY_ID }),
  );
  assert.equal(rpcCalls.length, 0);
});

test("applyPersonnelRosterImport: companyId inválido bloquea antes de leer o llamar RPC", async () => {
  const { client, rpcCalls, scopedReads } = mockSupabase();
  const bytes = buildWorkbookBytes([row(1, "PEREZ", "JUAN", "11.111.111-1", "OPERARIO DE PRODUCCION")]);

  await assert.rejects(
    () => applyPersonnelRosterImport(client, { fileBytes: bytes, actorId: "actor-1", companyId: "" }),
    /requiere una empresa válida/,
  );
  assert.deepEqual(scopedReads, []);
  assert.deepEqual(rpcCalls, []);
});
