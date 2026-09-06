import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOvertime } from "./overtime-decisions";

function mockSupabase(
  candidateMinutes: number,
  insertedRows: Record<string, unknown>[],
  options: { recordCurrent?: boolean; recordFilters?: Array<[string, unknown]> } = {}
) {
  return {
    from(table: string) {
      if (table === "overtime_records") {
        const filters: Array<[string, unknown]> = [];
        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            options.recordFilters?.push([column, value]);
            return this;
          },
          single() {
            if (options.recordCurrent === false && filters.some(([column, value]) => column === "is_current" && value === true)) {
              return Promise.resolve({ data: null, error: { message: "no rows" } });
            }
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

test("decideOvertime: nunca permite decidir un candidato que ya no es vigente", async () => {
  const inserted: Record<string, unknown>[] = [];
  const filters: Array<[string, unknown]> = [];
  const supabase = mockSupabase(118, inserted, { recordCurrent: false, recordFilters: filters });

  await assert.rejects(
    () => decideOvertime(supabase, { overtimeRecordId: "ot-stale", action: "APPROVE", reason: null }),
    /registro de horas extra no encontrado/
  );

  assert.deepEqual(inserted, []);
  assert.ok(filters.some(([column, value]) => column === "is_current" && value === true));
});
