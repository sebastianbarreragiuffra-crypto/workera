import { test } from "node:test";
import assert from "node:assert/strict";
import type { Json } from "@/lib/supabase/database.types";
import { ExpenseOcrError } from "./errors";
import type { ClaimedExpenseOcrJob, ExpenseOcrRepository } from "./repository";
import { runExpenseOcrWorker, type ExpenseOcrProvider } from "./worker";

function job(overrides: Partial<ClaimedExpenseOcrJob> = {}): ClaimedExpenseOcrJob {
  return { jobId: "job-1", companyId: "company-1", receiptId: "receipt-1", storagePath: "private/file.pdf", mimeType: "application/pdf", attempt: 1, providerOperationUrl: null, expenseDate: "2026-08-10", merchantName: "Hotel", netAmount: 100, taxAmount: 19, totalAmount: 119, currencyCode: "CLP", ...overrides };
}

class FakeRepository implements ExpenseOcrRepository {
  completed: Json[] = [];
  deferred: string[] = [];
  failures: Array<{ category: string; retryable: boolean }> = [];
  downloads: string[] = [];
  constructor(private readonly jobs: ClaimedExpenseOcrJob[]) {}
  async reclaim() { return 1; }
  async claim() { return this.jobs; }
  async downloadPrivateReceipt(path: string) { this.downloads.push(path); return new ArrayBuffer(2); }
  async defer(_jobId: string, _workerId: string, url: string) { this.deferred.push(url); }
  async complete(_jobId: string, _workerId: string, extraction: Json) { this.completed.push(extraction); }
  async fail(_jobId: string, _workerId: string, category: string, _summary: string, retryable: boolean) { this.failures.push({ category, retryable }); return retryable; }
}

test("worker descarga únicamente jobs nuevos, difiere polling y completa resultados normalizados", async () => {
  const repository = new FakeRepository([job(), job({ jobId: "job-2", providerOperationUrl: "https://azure.test/op/2" })]);
  const provider: ExpenseOcrProvider = {
    async startReceiptAnalysis() { return { state: "pending", operationUrl: "https://azure.test/op/1" }; },
    async pollReceiptAnalysis(operationUrl) { return { state: "succeeded", operationUrl, result: { analyzeResult: { documents: [{ fields: { Total: { valueCurrency: { amount: 119, currencyCode: "CLP" }, confidence: 0.95 }, MerchantName: { valueString: "Hotel", confidence: 0.95 }, TransactionDate: { valueDate: "2026-08-10", confidence: 0.95 } } }] } } }; },
  };
  const summary = await runExpenseOcrWorker(repository, provider, { workerId: "worker", limit: 2 });
  assert.deepEqual(summary, { reclaimed: 1, claimed: 2, completed: 1, deferred: 1, failed: 0, retried: 0 });
  assert.deepEqual(repository.downloads, ["private/file.pdf"]);
  assert.equal(repository.completed.length, 1);
});

test("worker clasifica el error y solo solicita reintento cuando corresponde", async () => {
  const repository = new FakeRepository([job()]);
  const provider: ExpenseOcrProvider = {
    async startReceiptAnalysis() { throw new ExpenseOcrError("PROVIDER_RATE_LIMIT", "Temporal", true); },
    async pollReceiptAnalysis() { throw new Error("no usado"); },
  };
  const summary = await runExpenseOcrWorker(repository, provider, { workerId: "worker" });
  assert.equal(summary.failed, 1);
  assert.equal(summary.retried, 1);
  assert.deepEqual(repository.failures, [{ category: "PROVIDER_RATE_LIMIT", retryable: true }]);
});
