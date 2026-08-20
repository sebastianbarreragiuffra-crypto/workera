import { test } from "node:test";
import assert from "node:assert/strict";
import { getEmployeeDetail } from "./employee-detail-view";
import { AreaAccessError } from "../access/scope";

interface MockOptions {
  areaCode?: string | null;
  active?: boolean;
  lateArrivals?: { work_date: string; detected_minutes: number; late_arrival_decisions: { justified: boolean; is_current: boolean } | null }[];
  documents?: { id: string; document_type: string; original_filename: string; uploaded_at: string }[];
}

function mockSupabase({ areaCode = "PRODUCTION", active = true, lateArrivals = [], documents = [] }: MockOptions) {
  function chain(resolve: () => { data: unknown; error: null }) {
    const builder = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      lte() {
        return builder;
      },
      gte() {
        return builder;
      },
      or() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(resolve());
      },
      single() {
        return Promise.resolve(resolve());
      },
      then(onResolve: (r: { data: unknown; error: null }) => void) {
        onResolve(resolve());
      },
    };
    return builder;
  }

  return {
    from(table: string) {
      switch (table) {
        case "employees":
          return chain(() => ({
            data: { id: "e1", display_name: "María Araya", active, employee_groups: areaCode ? { code: areaCode } : null },
            error: null,
          }));
        case "employee_time_control_policies":
          return chain(() => ({ data: null, error: null }));
        case "schedule_assignments":
          return chain(() => ({ data: null, error: null }));
        case "late_arrival_records":
          return chain(() => ({ data: lateArrivals, error: null }));
        case "overtime_records":
          return chain(() => ({ data: [], error: null }));
        case "absence_records":
          return chain(() => ({ data: [], error: null }));
        case "supporting_documents_metadata":
          return chain(() => ({ data: documents, error: null }));
        default:
          return chain(() => ({ data: null, error: null }));
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("getEmployeeDetail: supervisor de Producción puede ver el detalle de un empleado de Producción", async () => {
  const supabase = mockSupabase({ areaCode: "PRODUCTION" });
  const detail = await getEmployeeDetail(supabase, "SUPERVISOR_PRODUCTION", "e1", "2026-08-20");
  assert.equal(detail.displayName, "María Araya");
  assert.equal(detail.areaCode, "PRODUCTION");
});

test("getEmployeeDetail: supervisor de Producción NO puede ver el detalle de un empleado de Instalación", async () => {
  const supabase = mockSupabase({ areaCode: "INSTALLATION" });
  await assert.rejects(() => getEmployeeDetail(supabase, "SUPERVISOR_PRODUCTION", "e1", "2026-08-20"), AreaAccessError);
});

test("getEmployeeDetail: empleado sin área asignada -> AreaAccessError, nunca se asume un área", async () => {
  const supabase = mockSupabase({ areaCode: null });
  await assert.rejects(() => getEmployeeDetail(supabase, "ADMIN_RRHH", "e1", "2026-08-20"), AreaAccessError);
});

test("getEmployeeDetail: sin novedades recientes -> arrays vacíos, nunca undefined ni un error", async () => {
  const supabase = mockSupabase({ areaCode: "PRODUCTION" });
  const detail = await getEmployeeDetail(supabase, "ADMIN_RRHH", "e1", "2026-08-20");
  assert.deepEqual(detail.recentLateArrivals, []);
  assert.deepEqual(detail.recentOvertime, []);
  assert.deepEqual(detail.recentAbsences, []);
  assert.deepEqual(detail.documents, []);
});

test("getEmployeeDetail: atraso con decisión pendiente (sin fila en late_arrival_decisions) -> justified null, nunca false por defecto", async () => {
  const supabase = mockSupabase({
    areaCode: "PRODUCTION",
    lateArrivals: [{ work_date: "2026-08-19", detected_minutes: 12, late_arrival_decisions: null }],
  });
  const detail = await getEmployeeDetail(supabase, "ADMIN_RRHH", "e1", "2026-08-20");
  assert.equal(detail.recentLateArrivals.length, 1);
  assert.equal(detail.recentLateArrivals[0].justified, null);
});

test("getEmployeeDetail: documentos con id null (columna nullable de la vista) se descartan, nunca se propagan a la UI", async () => {
  const supabase = mockSupabase({
    areaCode: "PRODUCTION",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    documents: [{ id: null, document_type: "OTHER", original_filename: "x.pdf", uploaded_at: "2026-08-19T00:00:00Z" } as any],
  });
  const detail = await getEmployeeDetail(supabase, "ADMIN_RRHH", "e1", "2026-08-20");
  assert.deepEqual(detail.documents, []);
});
