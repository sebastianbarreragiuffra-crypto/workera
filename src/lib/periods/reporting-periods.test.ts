import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_TRANSITIONS,
  statusLabel,
  transitionReportingPeriod,
  getReportingPeriodsBoard,
  type ReportingPeriodStatus,
} from "./reporting-periods";

// --- Máquina de estados ---

test("ALLOWED_TRANSITIONS: el ciclo feliz llega de OPEN a CLOSED", () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.OPEN, ["IN_REVIEW"]);
  assert.ok(ALLOWED_TRANSITIONS.IN_REVIEW.includes("READY_TO_CLOSE"));
  assert.ok(ALLOWED_TRANSITIONS.READY_TO_CLOSE.includes("CLOSED"));
});

test("ALLOWED_TRANSITIONS: un período cerrado solo puede reabrirse", () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.CLOSED, ["REOPENED"]);
});

test("ALLOWED_TRANSITIONS: nunca se salta directo de OPEN a CLOSED", () => {
  assert.ok(!ALLOWED_TRANSITIONS.OPEN.includes("CLOSED"));
});

test("statusLabel: traduce todos los estados", () => {
  const all: ReportingPeriodStatus[] = ["OPEN", "IN_REVIEW", "READY_TO_CLOSE", "CLOSED", "REOPENED"];
  for (const s of all) assert.ok(statusLabel(s).length > 0);
});

// --- transitionReportingPeriod ---

function mockUpdate(rowsReturned: { id: string }[] = [{ id: "p-1" }]) {
  const captured: { patch?: Record<string, unknown>; eqs: [string, string][] } = { eqs: [] };
  const supabase = {
    from() {
      return {
        update(patch: Record<string, unknown>) {
          captured.patch = patch;
          return this;
        },
        eq(col: string, val: string) {
          captured.eqs.push([col, val]);
          return this;
        },
        select() {
          return Promise.resolve({ data: rowsReturned, error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { supabase, captured };
}

test("transitionReportingPeriod: rechaza una transición no permitida antes de tocar la base", async () => {
  const { supabase, captured } = mockUpdate();
  await assert.rejects(
    () => transitionReportingPeriod(supabase, { periodId: "p-1", from: "OPEN", to: "CLOSED", actorId: "u-1" }),
    /no permitida/i
  );
  assert.equal(captured.patch, undefined, "no debe haber intentado escribir");
});

test("transitionReportingPeriod: al cerrar setea closed_by y closed_at en el mismo update (lo exige la policy)", async () => {
  const { supabase, captured } = mockUpdate();
  await transitionReportingPeriod(supabase, { periodId: "p-1", from: "READY_TO_CLOSE", to: "CLOSED", actorId: "u-1" });
  assert.equal(captured.patch?.status, "CLOSED");
  assert.equal(captured.patch?.closed_by, "u-1");
  assert.ok(captured.patch?.closed_at);
});

test("transitionReportingPeriod: reabrir sin motivo falla", async () => {
  const { supabase } = mockUpdate();
  await assert.rejects(
    () => transitionReportingPeriod(supabase, { periodId: "p-1", from: "CLOSED", to: "REOPENED", actorId: "u-1", reopenReason: "  " }),
    /motivo/i
  );
});

test("transitionReportingPeriod: reabrir con motivo setea reopened_by, reopened_at y reopen_reason", async () => {
  const { supabase, captured } = mockUpdate();
  await transitionReportingPeriod(supabase, {
    periodId: "p-1",
    from: "CLOSED",
    to: "REOPENED",
    actorId: "u-1",
    reopenReason: "error en marcación de Juan",
  });
  assert.equal(captured.patch?.reopen_reason, "error en marcación de Juan");
  assert.equal(captured.patch?.reopened_by, "u-1");
});

test("transitionReportingPeriod: el update filtra por el estado actual esperado (protección de concurrencia)", async () => {
  const { supabase, captured } = mockUpdate();
  await transitionReportingPeriod(supabase, { periodId: "p-1", from: "OPEN", to: "IN_REVIEW", actorId: "u-1" });
  assert.ok(captured.eqs.some(([c, v]) => c === "id" && v === "p-1"));
  assert.ok(captured.eqs.some(([c, v]) => c === "status" && v === "OPEN"));
});

test("transitionReportingPeriod: si el update no afecta ninguna fila, avisa que el estado cambió", async () => {
  const { supabase } = mockUpdate([]); // 0 filas
  await assert.rejects(
    () => transitionReportingPeriod(supabase, { periodId: "p-1", from: "OPEN", to: "IN_REVIEW", actorId: "u-1" }),
    /cambió de estado/i
  );
});

// --- getReportingPeriodsBoard: sugerencia del siguiente ciclo ---

function mockList(rows: { period_start: string; period_end: string; status: string }[]) {
  const supabase = {
    from() {
      return {
        select() {
          return this;
        },
        order() {
          return Promise.resolve({
            data: rows.map((r, i) => ({ id: `p-${i}`, closed_at: null, reopened_at: null, reopen_reason: null, ...r })),
            error: null,
          });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return supabase;
}

test("getReportingPeriodsBoard: sugiere el ciclo siguiente al último período (16-15)", async () => {
  const board = await getReportingPeriodsBoard(
    mockList([{ period_start: "2026-08-16", period_end: "2026-09-15", status: "CLOSED" }])
  );
  // Último ciclo = pago septiembre; el siguiente = pago octubre (16-sep al 15-oct).
  assert.equal(board.suggestedNext.periodStart, "2026-09-16");
  assert.equal(board.suggestedNext.periodEnd, "2026-10-15");
});

test("getReportingPeriodsBoard: el rollover de diciembre a enero funciona", async () => {
  const board = await getReportingPeriodsBoard(
    mockList([{ period_start: "2026-11-16", period_end: "2026-12-15", status: "CLOSED" }])
  );
  assert.equal(board.suggestedNext.periodStart, "2026-12-16");
  assert.equal(board.suggestedNext.periodEnd, "2027-01-15");
});
