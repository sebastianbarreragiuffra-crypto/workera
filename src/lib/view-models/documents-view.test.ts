import { test } from "node:test";
import assert from "node:assert/strict";
import { getDocumentCenter } from "./documents-view";

interface FakeDoc {
  id: string;
  employee_id: string;
  document_type: string;
  original_filename: string;
  uploaded_at: string;
}

interface FakeEmployee {
  id: string;
  display_name: string;
  employee_groups: { code: string } | null;
}

function mockSupabase(docs: FakeDoc[], employees: FakeEmployee[]) {
  return {
    from(table: string) {
      if (table === "supporting_documents_metadata") {
        let filtered = docs;
        const builder = {
          select() {
            return builder;
          },
          order() {
            return builder;
          },
          eq(_col: string, value: string) {
            filtered = filtered.filter((d) => d.employee_id === value);
            return builder;
          },
          then(onResolve: (r: { data: unknown; error: null }) => void) {
            onResolve({ data: filtered, error: null });
          },
        };
        return builder;
      }
      if (table === "employees") {
        const builder = {
          select() {
            return builder;
          },
          in(_col: string, ids: string[]) {
            return { then: (onResolve: (r: { data: unknown; error: null }) => void) => onResolve({ data: employees.filter((e) => ids.includes(e.id)), error: null }) };
          },
        };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const DOCS: FakeDoc[] = [
  { id: "d1", employee_id: "e1", document_type: "MEDICAL_CERTIFICATE", original_filename: "a.pdf", uploaded_at: "2026-08-19T10:00:00Z" },
  { id: "d2", employee_id: "e2", document_type: "OTHER", original_filename: "b.pdf", uploaded_at: "2026-08-19T11:00:00Z" },
];
const EMPLOYEES: FakeEmployee[] = [
  { id: "e1", display_name: "María Araya", employee_groups: { code: "PRODUCTION" } },
  { id: "e2", display_name: "Ana Soto", employee_groups: { code: "INSTALLATION" } },
];

test("getDocumentCenter: SUPERVISOR_PRODUCTION solo ve documentos de trabajadores de Producción", async () => {
  const supabase = mockSupabase(DOCS, EMPLOYEES);
  const result = await getDocumentCenter(supabase, "SUPERVISOR_PRODUCTION", {});
  assert.equal(result.length, 1);
  assert.equal(result[0].employeeId, "e1");
});

test("getDocumentCenter: ADMIN_RRHH ve documentos de todas las áreas", async () => {
  const supabase = mockSupabase(DOCS, EMPLOYEES);
  const result = await getDocumentCenter(supabase, "ADMIN_RRHH", {});
  assert.equal(result.length, 2);
});

test("getDocumentCenter: solo SUPER_ADMIN/ADMIN_RRHH pueden ver el contenido (canView) -- nunca un supervisor", async () => {
  const supabase = mockSupabase(DOCS, EMPLOYEES);
  const asSupervisor = await getDocumentCenter(supabase, "SUPERVISOR_PRODUCTION", {});
  const asAdmin = await getDocumentCenter(supabase, "ADMIN_RRHH", {});
  assert.ok(asSupervisor.every((d) => d.canView === false));
  assert.ok(asAdmin.every((d) => d.canView === true));
});

test("getDocumentCenter: filtro de área fuera del alcance del rol -> rechaza (AreaAccessError)", async () => {
  const supabase = mockSupabase(DOCS, EMPLOYEES);
  await assert.rejects(() => getDocumentCenter(supabase, "SUPERVISOR_PRODUCTION", { areaCode: "INSTALLATION" }));
});

test("getDocumentCenter: sin documentos -> arreglo vacío, nunca un error", async () => {
  const supabase = mockSupabase([], EMPLOYEES);
  const result = await getDocumentCenter(supabase, "ADMIN_RRHH", {});
  assert.deepEqual(result, []);
});
