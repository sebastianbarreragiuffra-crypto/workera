import { test } from "node:test";
import assert from "node:assert/strict";
import { markEarlyDepartureMedical, confirmEarlyDepartureMedicalDocument, decideEarlyDepartureOther } from "./early-departure-decisions";

function mockSupabase(detectedMinutes: number, insertedRows: Record<string, unknown>[]) {
  return {
    from(table: string) {
      if (table === "early_departure_records") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          single() {
            return Promise.resolve({ data: { detected_minutes: detectedMinutes }, error: null });
          },
        };
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

test("markEarlyDepartureMedical: NEEDS_REVIEW con documento requerido y plazo de 3 días hábiles", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(40, inserted);

  await markEarlyDepartureMedical(supabase, { earlyDepartureRecordId: "ed-1", workDate: "2026-08-19", reason: null });

  assert.equal(inserted[0].reason_category, "MEDICAL");
  assert.equal(inserted[0].document_required, true);
  assert.equal(inserted[0].payroll_effect, "NEEDS_REVIEW");
  assert.ok(inserted[0].document_deadline);
});

test("confirmEarlyDepartureMedicalDocument: cierra con DO_NOT_DEDUCT (el trigger real valida que exista el documento)", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(40, inserted);

  await confirmEarlyDepartureMedicalDocument(supabase, { earlyDepartureRecordId: "ed-1", workDate: "2026-08-19", reason: null });

  assert.equal(inserted[0].reason_category, "MEDICAL");
  assert.equal(inserted[0].payroll_effect, "DO_NOT_DEDUCT");
  assert.equal(inserted[0].payroll_minutes, 0);
});

test("decideEarlyDepartureOther: OTHER_JUSTIFIED -> DO_NOT_DEDUCT, sin documento requerido", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(15, inserted);

  await decideEarlyDepartureOther(supabase, { earlyDepartureRecordId: "ed-1", reasonCategory: "OTHER_JUSTIFIED", reason: "trámite personal" });

  assert.equal(inserted[0].payroll_effect, "DO_NOT_DEDUCT");
  assert.equal(inserted[0].payroll_minutes, 0);
  assert.equal(inserted[0].document_required, false);
});

test("decideEarlyDepartureOther: UNJUSTIFIED -> DEDUCT por los minutos detectados completos", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(15, inserted);

  await decideEarlyDepartureOther(supabase, { earlyDepartureRecordId: "ed-1", reasonCategory: "UNJUSTIFIED", reason: null });

  assert.equal(inserted[0].payroll_effect, "DEDUCT");
  assert.equal(inserted[0].payroll_minutes, 15);
});
