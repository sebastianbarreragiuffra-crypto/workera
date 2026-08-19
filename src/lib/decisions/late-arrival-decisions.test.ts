import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLateArrival } from "./late-arrival-decisions";

function mockSupabase(detectedMinutes: number, insertedRows: Record<string, unknown>[]) {
  return {
    from(table: string) {
      if (table === "late_arrival_records") {
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

test("decideLateArrival: justificado -> payroll_minutes=0, payroll_effect=DO_NOT_DEDUCT", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(12, inserted);

  const result = await decideLateArrival(supabase, { lateArrivalRecordId: "lar-1", justified: true, reason: null });

  assert.equal(result.decisionId, "decision-1");
  assert.equal(inserted[0].justified, true);
  assert.equal(inserted[0].payroll_minutes, 0);
  assert.equal(inserted[0].payroll_effect, "DO_NOT_DEDUCT");
});

test("decideLateArrival: no justificado -> payroll_minutes=detected_minutes, payroll_effect=DEDUCT", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(12, inserted);

  await decideLateArrival(supabase, { lateArrivalRecordId: "lar-1", justified: false, reason: "sin aviso" });

  assert.equal(inserted[0].justified, false);
  assert.equal(inserted[0].payroll_minutes, 12);
  assert.equal(inserted[0].payroll_effect, "DEDUCT");
  assert.equal(inserted[0].reason, "sin aviso");
});
