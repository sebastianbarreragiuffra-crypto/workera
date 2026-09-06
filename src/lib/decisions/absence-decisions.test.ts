import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { markAbsencePendingDocument, confirmAbsenceDocument, disputeAbsence } from "./absence-decisions";

function mockSupabase(insertedRows: Record<string, unknown>[], holidays: string[] = []) {
  return {
    from(table: string) {
      if (table === "holidays") {
        // Cadena select().eq().gte().lte() que resuelve como promesa.
        const result = { data: holidays.map((d) => ({ holiday_date: d })), error: null };
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "gte", "lte"]) chain[m] = () => chain;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (chain as any).then = (resolve: (v: unknown) => void) => resolve(result);
        return chain;
      }
      return {
        insert(row: Record<string, unknown>) {
          insertedRows.push(row);
          return this;
        },
        select() {
          return this;
        },
        single() {
          return Promise.resolve({ data: { id: "decision-1" }, error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("markAbsencePendingDocument: PENDING_DOCUMENT con documento requerido y plazo calculado", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(inserted);

  await markAbsencePendingDocument(supabase, { absenceRecordId: "ab-1", startDate: "2026-08-19", reason: null });

  assert.equal(inserted[0].decision_status, "PENDING_DOCUMENT");
  assert.equal(inserted[0].document_required, true);
  assert.ok(inserted[0].document_deadline);
});

test("confirmAbsenceDocument: CONFIRMED (el trigger real exige que ya exista el documento adjunto)", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(inserted);

  await confirmAbsenceDocument(supabase, { absenceRecordId: "ab-1", startDate: "2026-08-19", reason: null });

  assert.equal(inserted[0].decision_status, "CONFIRMED");
  assert.equal(inserted[0].document_required, true);
});

test("disputeAbsence: DISPUTED, sin documento requerido -- queda para revisión manual de RRHH", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(inserted);

  await disputeAbsence(supabase, { absenceRecordId: "ab-1", reason: "no corresponde" });

  assert.equal(inserted[0].decision_status, "DISPUTED");
  assert.equal(inserted[0].document_required, false);
  assert.equal(inserted[0].document_deadline, null);
});

test("ausencias: autoridad histórica por rango, tenant exacto, cierre y reemplazo inmutable", () => {
  const authority = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906160000_labor_decision_authority.sql",
  ), "utf8");
  const replacement = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906190000_rrhh_atomic_decision_replacement.sql",
  ), "utf8");
  const integrity = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906210000_payroll_revision_state_integrity.sql",
  ), "utf8");

  assert.match(authority, /can_manage_employee_for_date_range/);
  assert.match(authority, /range_agg\([\s\S]*?daterange\(p_start_date, p_end_date/);
  assert.match(authority, /create policy absence_decisions_insert[\s\S]*?can_manage_employee_for_date_range/);
  assert.doesNotMatch(
    authority.slice(authority.indexOf("create policy absence_decisions_insert")),
    /can_manage_employee\(ar\.employee_id\)/,
  );
  assert.match(authority, /create policy absence_records_insert[\s\S]*?has_company_app_role\(e\.company_id, 'ADMIN_RRHH'\)/);
  assert.match(authority, /prevent_labor_decision_on_closed_period[\s\S]*?payroll-source-mutation-v1[\s\S]*?rp\.status = 'CLOSED'/);
  assert.match(authority, /absence_decisions_prevent_closed_period/);
  assert.match(replacement, /absence_decisions_prepare_rrhh_replacement/);
  assert.match(replacement, /revoke update on public\.absence_decisions from authenticated/);
  assert.match(integrity, /sync_employee_group_history_from_cache/);
  assert.match(integrity, /insert into public\.employee_group_assignments/);
  assert.match(integrity, /after update of employee_group_id on public\.employees/);
  assert.match(integrity, /v_initial_from[\s\S]*?new\.hire_date[\s\S]*?attendance_records[\s\S]*?absence_records/);
  assert.match(integrity, /effective_from, effective_to[\s\S]*?v_initial_from/);
  assert.match(integrity, /revoke insert, update, delete on public\.employee_group_assignments[\s\S]*?authenticated, service_role/);
  assert.match(integrity, /prevent_payroll_layer_mutation_on_closed_period/);
  assert.match(integrity, /'absence_records'[\s\S]*?'attendance_status_records'[\s\S]*?'employee_daily_bonuses'/);
  assert.match(integrity, /attendance_missing_punch_flags_update[\s\S]*?can_manage_employee_on_date\(employee_id, work_date\)/);
  assert.match(integrity, /attendance_missing_punch_flags_identity_immutable[\s\S]*?enforce_immutable_columns\([\s\S]*?'status'[\s\S]*?'updated_at'/);
});
