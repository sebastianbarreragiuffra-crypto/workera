import "server-only";
import assert from "node:assert/strict";
import test from "node:test";
import { DryRunLedgerAdapter, ExpenseAccountingProviderError, type ExpenseAccountingAdapter, type ExpenseAccountingExportJob } from "./adapter";
import type { CompleteAccountingJobInput, ExpenseAccountingCompletionStatus, ExpenseAccountingRepository } from "./repository";
import { runExpenseAccountingWorker } from "./worker";
import { parseExpenseAccountingPayload } from "./payload";
import { validAccountingPayload } from "./fixture";

function job(id = "20000000-0000-4000-8000-000000000001"): ExpenseAccountingExportJob {
  return {
    exportId: id,
    companyId: "10000000-0000-4000-8000-000000000001",
    idempotencyKey: "a".repeat(64),
    payload: parseExpenseAccountingPayload(validAccountingPayload),
    attemptCount: 1,
    leaseToken: "20000000-0000-4000-8000-000000000002",
  };
}

class FakeRepository implements ExpenseAccountingRepository {
  completed: CompleteAccountingJobInput[] = [];
  claimCalls = 0;
  constructor(
    private readonly jobs: ExpenseAccountingExportJob[],
    private readonly completionStatus: ExpenseAccountingCompletionStatus = "SUCCEEDED",
    private readonly completionError: Error | null = null
  ) {}
  async claim(limit: number): Promise<ExpenseAccountingExportJob[]> {
    this.claimCalls += 1;
    return this.jobs.splice(0, limit);
  }
  async complete(input: CompleteAccountingJobInput): Promise<ExpenseAccountingCompletionStatus> {
    this.completed.push(input);
    if (this.completionError) throw this.completionError;
    return input.succeeded ? this.completionStatus : this.completionStatus === "SUCCEEDED" ? "FAILED" : this.completionStatus;
  }
}

test("dry-run produce una referencia determinista sin red", async () => {
  const result = await new DryRunLedgerAdapter().export(job());
  assert.equal(result.externalReference, "DRYRUN-AAAAAAAAAAAAAAAA");
});

test("worker cierra cada job con su mismo token de fencing", async () => {
  const repository = new FakeRepository([job()]);
  const summary = await runExpenseAccountingWorker(repository, new DryRunLedgerAdapter());
  assert.deepEqual(summary, { claimed: 1, succeeded: 1, retried: 0, failed: 0 });
  assert.equal(repository.completed[0].leaseToken, job().leaseToken);
  assert.equal(repository.completed[0].succeeded, true);
});

test("solo errores tipados retryable vuelven a la cola", async () => {
  const retryAdapter: ExpenseAccountingAdapter = {
    providerCode: "LEDGER_CSV_V1",
    async export() { throw new ExpenseAccountingProviderError("RATE_LIMIT", true); },
  };
  const retryRepository = new FakeRepository([job()], "RETRY");
  const retrySummary = await runExpenseAccountingWorker(retryRepository, retryAdapter);
  assert.equal(retrySummary.retried, 1);
  assert.equal(retryRepository.completed[0].retryable, true);

  const crashAdapter: ExpenseAccountingAdapter = {
    providerCode: "LEDGER_CSV_V1",
    async export() { throw new Error("secreto interno"); },
  };
  const crashRepository = new FakeRepository([job()]);
  const crashSummary = await runExpenseAccountingWorker(crashRepository, crashAdapter);
  assert.equal(crashSummary.failed, 1);
  assert.equal(crashRepository.completed[0].errorCode, "UNEXPECTED_ADAPTER_ERROR");
  assert.doesNotMatch(crashRepository.completed[0].errorSummary ?? "", /secreto interno/);
});

test("un adapter no puede volver reintentable un código financiero incierto", async () => {
  const adapter: ExpenseAccountingAdapter = {
    providerCode: "LEDGER_CSV_V1",
    async export() { throw new ExpenseAccountingProviderError("NETWORK_AFTER_SEND", true); },
  };
  const repository = new FakeRepository([job()], "FAILED");
  const summary = await runExpenseAccountingWorker(repository, adapter);
  assert.equal(summary.failed, 1);
  assert.equal(repository.completed[0].errorCode, "NETWORK_AFTER_SEND");
  assert.equal(repository.completed[0].retryable, false);
});

test("el resumen usa el estado terminal devuelto por la base en el último intento", async () => {
  const retryAdapter: ExpenseAccountingAdapter = {
    providerCode: "LEDGER_CSV_V1",
    async export() { throw new ExpenseAccountingProviderError("RATE_LIMIT", true); },
  };
  const exhaustedRepository = new FakeRepository([job()], "FAILED");
  const summary = await runExpenseAccountingWorker(exhaustedRepository, retryAdapter);
  assert.deepEqual(summary, { claimed: 1, succeeded: 0, retried: 0, failed: 1 });
});

test("un fallo persistiendo el éxito no se convierte en fallo del proveedor", async () => {
  const repository = new FakeRepository([job()], "SUCCEEDED", new Error("base no disponible"));
  await assert.rejects(
    runExpenseAccountingWorker(repository, new DryRunLedgerAdapter()),
    /base no disponible/
  );
  assert.equal(repository.completed.length, 1);
  assert.equal(repository.completed[0].succeeded, true);
});

test("un timeout queda en revisión humana porque el resultado externo es incierto", async () => {
  const adapter: ExpenseAccountingAdapter = {
    providerCode: "LEDGER_CSV_V1",
    async export() { return await new Promise(() => undefined); },
  };
  const repository = new FakeRepository([job()], "FAILED");
  const summary = await runExpenseAccountingWorker(repository, adapter, 1, { jobTimeoutMs: 20 });
  assert.equal(summary.failed, 1);
  assert.equal(repository.completed[0].errorCode, "ADAPTER_TIMEOUT");
  assert.equal(repository.completed[0].retryable, false);
});

test("un error retryable emitido al abortar también se normaliza como timeout incierto", async () => {
  const adapter: ExpenseAccountingAdapter = {
    providerCode: "LEDGER_CSV_V1",
    async export(_job, context) {
      return await new Promise((_resolve, reject) => {
        context?.signal.addEventListener("abort", () => {
          reject(new ExpenseAccountingProviderError("NETWORK_ABORTED", true));
        }, { once: true });
      });
    },
  };
  const repository = new FakeRepository([job()], "FAILED");
  const summary = await runExpenseAccountingWorker(repository, adapter, 1, { jobTimeoutMs: 20 });
  assert.equal(summary.failed, 1);
  assert.equal(repository.completed[0].errorCode, "ADAPTER_TIMEOUT");
  assert.equal(repository.completed[0].retryable, false);
});

test("el worker no reclama otro job sin presupuesto para procesarlo y cerrar su lease", async () => {
  const repository = new FakeRepository([job()]);
  const summary = await runExpenseAccountingWorker(repository, new DryRunLedgerAdapter(), 1, {
    deadlineAtMs: Date.now() + 1_000,
    jobTimeoutMs: 1_000,
  });
  assert.deepEqual(summary, { claimed: 0, succeeded: 0, retried: 0, failed: 0 });
  assert.equal(repository.claimCalls, 0);
});
