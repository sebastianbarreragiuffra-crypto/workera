import { test } from "node:test";
import assert from "node:assert/strict";
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
