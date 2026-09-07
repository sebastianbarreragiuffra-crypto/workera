import assert from "node:assert/strict";
import test from "node:test";
import { runExpenseFileScanSequentialBatch } from "./service";
import type { ExpenseFileScanWorkerSummary } from "./worker";

const unusedRepository = {} as Parameters<typeof runExpenseFileScanSequentialBatch>[0];
const unusedScanner = {} as Parameters<typeof runExpenseFileScanSequentialBatch>[1];

function summary(overrides: Partial<ExpenseFileScanWorkerSummary>): ExpenseFileScanWorkerSummary {
  return { reclaimed: 0, claimed: 0, clean: 0, rejected: 0, failed: 0, retried: 0, ...overrides };
}

test("el batch real reclama de a uno, agrega resultados y termina al vaciar la cola", async () => {
  const sequence = [summary({ claimed: 1, clean: 1 }), summary({ claimed: 1, rejected: 1 }), summary({})];
  const limits: number[] = [];
  const result = await runExpenseFileScanSequentialBatch(
    unusedRepository,
    unusedScanner,
    { maxFiles: 10, maxRuntimeMs: 45_000, requestTimeoutMs: 15_000, now: () => 0 },
    async (_repository, _scanner, options) => {
      limits.push(options?.limit ?? 0);
      return sequence.shift()!;
    },
  );
  assert.deepEqual(limits, [1, 1, 1]);
  assert.deepEqual(result, summary({ claimed: 2, clean: 1, rejected: 1 }));
});

test("un fallo corta el batch antes de reclamar otro lease", async () => {
  let calls = 0;
  const result = await runExpenseFileScanSequentialBatch(
    unusedRepository,
    unusedScanner,
    { maxFiles: 10, maxRuntimeMs: 45_000, requestTimeoutMs: 15_000, now: () => 0 },
    async () => {
      calls += 1;
      return summary({ claimed: 1, failed: 1, retried: 1 });
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, summary({ claimed: 1, failed: 1, retried: 1 }));
});

test("no inicia otra transferencia si ya no cabe el timeout completo", async () => {
  let now = 0;
  let calls = 0;
  const result = await runExpenseFileScanSequentialBatch(
    unusedRepository,
    unusedScanner,
    { maxFiles: 10, maxRuntimeMs: 45_000, requestTimeoutMs: 15_000, now: () => now },
    async () => {
      calls += 1;
      now = 30_000;
      return summary({ claimed: 1, clean: 1 });
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, summary({ claimed: 1, clean: 1 }));
});
