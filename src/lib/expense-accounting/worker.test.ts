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
  constructor(
    private readonly jobs: ExpenseAccountingExportJob[],
    private readonly completionStatus: ExpenseAccountingCompletionStatus = "SUCCEEDED",
    private readonly completionError: Error | null = null
  ) {}
  async claim(): Promise<ExpenseAccountingExportJob[]> { return this.jobs; }
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
