import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOvertime } from "./overtime-decisions";

function mockSupabase(candidateMinutes: number, insertedRows: Record<string, unknown>[]) {
  return {
    from(table: string) {
      if (table === "overtime_records") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          single() {
            return Promise.resolve({ data: { candidate_minutes: candidateMinutes }, error: null });
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

test("decideOvertime: APPROVE -> FULLY_APPROVED con todos los minutos candidatos aprobados", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(118, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-1", action: "APPROVE", reason: null });

  assert.equal(inserted[0].decision_status, "FULLY_APPROVED");
  assert.equal(inserted[0].approved_minutes, 118);
  assert.equal(inserted[0].rejected_minutes, 0);
});

test("decideOvertime: REJECT -> REJECTED con todos los minutos candidatos rechazados", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(118, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-1", action: "REJECT", reason: "no autorizado" });

  assert.equal(inserted[0].decision_status, "REJECTED");
  assert.equal(inserted[0].approved_minutes, 0);
  assert.equal(inserted[0].rejected_minutes, 118);
});

test("decideOvertime: candidate_minutes=0 -> rechaza antes de violar el constraint de la base", async () => {
  const supabase = mockSupabase(0, []);
  await assert.rejects(() => decideOvertime(supabase, { overtimeRecordId: "ot-1", action: "APPROVE", reason: null }));
});
