import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOvertime } from "./overtime-decisions";

interface MockRecord {
  candidateMinutes: number;
  workDate: string;
  groupCode: string;
  overtimeTypeCode: string;
}

function mockSupabase(
  recordInput: number | Partial<MockRecord>,
  insertedRows: Record<string, unknown>[],
  options: { recordCurrent?: boolean; recordFilters?: Array<[string, unknown]> } = {}
) {
  const record: MockRecord = {
    candidateMinutes: typeof recordInput === "number" ? recordInput : recordInput.candidateMinutes ?? 118,
    workDate: typeof recordInput === "number" ? "2026-08-18" : recordInput.workDate ?? "2026-08-18",
    groupCode: typeof recordInput === "number" ? "PRODUCTION" : recordInput.groupCode ?? "PRODUCTION",
    overtimeTypeCode: typeof recordInput === "number" ? "OVERTIME_50" : recordInput.overtimeTypeCode ?? "OVERTIME_50",
  };
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
            return Promise.resolve({
              data: {
                candidate_minutes: record.candidateMinutes,
                work_date: record.workDate,
                overtime_policy: { employee_groups: { code: record.groupCode } },
                overtime_type: { code: record.overtimeTypeCode },
              },
              error: null,
            });
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

test("decideOvertime: APPROVE conserva exactamente 1:58 y no genera bono por redondeo", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(118, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-1", action: "APPROVE", reason: null });

  assert.equal(inserted[0].decision_status, "FULLY_APPROVED");
  assert.equal(inserted[0].approved_minutes, 118);
  assert.equal(inserted[0].rejected_minutes, 0);
});

test("decideOvertime: menos de 60 minutos no son pagables aunque se intente aprobar", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase(59, inserted);

  await assert.rejects(
    () => decideOvertime(supabase, { overtimeRecordId: "ot-59", action: "APPROVE", reason: null }),
    /no aprobables.*Menos de una hora real/
  );
  assert.deepEqual(inserted, []);
});

test("decideOvertime: aplica tope de 120 y conserva la diferencia como rechazo parcial", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({ candidateMinutes: 121 }, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-121", action: "APPROVE", reason: "Tope automático" });

  assert.equal(inserted[0].decision_status, "PARTIALLY_APPROVED");
  assert.equal(inserted[0].approved_minutes, 120);
  assert.equal(inserted[0].rejected_minutes, 1);
});

test("decideOvertime: sábado normal de Producción también limita a 120 HH50", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({ candidateMinutes: 180, workDate: "2026-08-22" }, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-sat", action: "APPROVE", reason: "Tope automático" });

  assert.equal(inserted[0].decision_status, "PARTIALLY_APPROVED");
  assert.equal(inserted[0].approved_minutes, 120);
  assert.equal(inserted[0].rejected_minutes, 60);
});

test("decideOvertime: feriado HH100 limita a 360 y conserva minutos reales", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({
    candidateMinutes: 361,
    workDate: "2026-09-07",
    overtimeTypeCode: "OVERTIME_100",
  }, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-holiday", action: "APPROVE", reason: "Tope automático" });

  assert.equal(inserted[0].decision_status, "PARTIALLY_APPROVED");
  assert.equal(inserted[0].approved_minutes, 360);
  assert.equal(inserted[0].rejected_minutes, 1);
});

test("decideOvertime: domingo Instalaciones HH100 no tiene tope fijo", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({
    candidateMinutes: 620,
    workDate: "2026-08-23",
    groupCode: "INSTALLATION",
    overtimeTypeCode: "OVERTIME_100",
  }, inserted);

  await decideOvertime(supabase, { overtimeRecordId: "ot-install-sun", action: "APPROVE", reason: null });

  assert.equal(inserted[0].decision_status, "FULLY_APPROVED");
  assert.equal(inserted[0].approved_minutes, 620);
  assert.equal(inserted[0].rejected_minutes, 0);
});

test("decideOvertime: usa el grupo histórico congelado en la política, no la ficha actual", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({
    candidateMinutes: 620,
    workDate: "2026-08-23",
    groupCode: "INSTALLATION",
    overtimeTypeCode: "OVERTIME_100",
  }, inserted);

  await decideOvertime(supabase, {
    overtimeRecordId: "ot-frozen-policy",
    action: "APPROVE",
    reason: null,
  });

  assert.equal(inserted[0].approved_minutes, 620);
  assert.equal(inserted[0].decision_status, "FULLY_APPROVED");
});

test("decideOvertime: domingo Instalaciones permite reconocer solo una parte exacta", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({
    candidateMinutes: 480,
    workDate: "2026-08-23",
    groupCode: "INSTALLATION",
    overtimeTypeCode: "OVERTIME_100",
  }, inserted);

  await decideOvertime(supabase, {
    overtimeRecordId: "ot-install-partial",
    action: "APPROVE",
    approvedMinutes: 360,
    reason: "Jefatura reconoce seis horas",
  });

  assert.equal(inserted[0].approved_minutes, 360);
  assert.equal(inserted[0].rejected_minutes, 120);
  assert.equal(inserted[0].decision_status, "PARTIALLY_APPROVED");
});

test("decideOvertime: conserva 119 reales y permite reconocer 60 exactos", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({ candidateMinutes: 119 }, inserted);

  await decideOvertime(supabase, {
    overtimeRecordId: "ot-119-partial",
    action: "APPROVE",
    approvedMinutes: 60,
    reason: "Supervisor reconoce una hora",
  });

  assert.equal(inserted[0].approved_minutes, 60);
  assert.equal(inserted[0].rejected_minutes, 59);
});

test("decideOvertime: bloquea minutos reconocidos inválidos o parcial sin motivo", async () => {
  const supabase = mockSupabase({ candidateMinutes: 119 }, []);
  await assert.rejects(
    () => decideOvertime(supabase, { overtimeRecordId: "ot-too-many", action: "APPROVE", approvedMinutes: 120, reason: "x" }),
    /no pueden superar/
  );
  await assert.rejects(
    () => decideOvertime(supabase, { overtimeRecordId: "ot-no-reason", action: "APPROVE", approvedMinutes: 60, reason: null }),
    /parcial exige motivo/
  );
});

for (const blockedCase of [
  { name: "Producción en domingo", groupCode: "PRODUCTION", workDate: "2026-08-23", overtimeTypeCode: "OVERTIME_100" },
  { name: "Administración", groupCode: "ADMINISTRATION", workDate: "2026-08-18", overtimeTypeCode: "OVERTIME_50" },
]) {
  test(`decideOvertime: bloquea ${blockedCase.name}`, async () => {
    const inserted: Record<string, unknown>[] = [];
    const supabase = mockSupabase({ candidateMinutes: 120, ...blockedCase }, inserted);

    await assert.rejects(
      () => decideOvertime(supabase, { overtimeRecordId: "ot-blocked", action: "APPROVE", reason: null }),
      /no aprobables/
    );
    assert.deepEqual(inserted, []);
  });
}

test("decideOvertime: rechaza una clasificación congelada que contradice el calendario", async () => {
  const inserted: Record<string, unknown>[] = [];
  const supabase = mockSupabase({ candidateMinutes: 120, workDate: "2026-08-23", groupCode: "INSTALLATION" }, inserted);

  await assert.rejects(
    () => decideOvertime(supabase, { overtimeRecordId: "ot-bad-rate", action: "APPROVE", reason: null }),
    /clasificación congelada HH50 contradice la fecha/
  );
  assert.deepEqual(inserted, []);
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
