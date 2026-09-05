import assert from "node:assert/strict";
import test from "node:test";
import {
  SupportingDocumentCleanupError,
  type ClaimedSupportingDocumentCleanup,
  type SupportingDocumentCleanupRepository,
} from "./repository";
import { runSupportingDocumentCleanupWorker } from "./worker";

class MemoryRepository implements SupportingDocumentCleanupRepository {
  readonly removed: string[] = [];
  readonly completed: string[] = [];
  readonly failures: Array<{ id: string; code: string; retryable: boolean }> = [];

  constructor(
    private readonly jobs: ClaimedSupportingDocumentCleanup[],
    private readonly brokenPaths = new Set<string>(),
  ) {}

  async reclaim(): Promise<number> { return 1; }
  async claim(): Promise<ClaimedSupportingDocumentCleanup[]> { return this.jobs; }
  async remove(path: string): Promise<void> {
    if (this.brokenPaths.has(path)) throw new SupportingDocumentCleanupError();
    this.removed.push(path);
  }
  async complete(intentId: string): Promise<void> { this.completed.push(intentId); }
  async fail(
    intentId: string,
    _workerId: string,
    errorCode: string,
    retryable: boolean,
  ): Promise<boolean> {
    this.failures.push({ id: intentId, code: errorCode, retryable });
    return retryable;
  }
  async getHealth() {
    return {
      pendingReadyCount: 0,
      lockedCount: 0,
      failedCount: 0,
      stalePendingCount: 0,
      oldestPendingExpiresAt: null,
      requiresAttention: false,
    };
  }
}

function job(id: string): ClaimedSupportingDocumentCleanup {
  return { intentId: id, storagePath: `employee/${id}.pdf`, attempt: 1 };
}

test("el worker elimina y cierra cada lease sin enumerar el bucket", async () => {
  const repository = new MemoryRepository([job("one"), job("two")]);
  const result = await runSupportingDocumentCleanupWorker(repository, {
    workerId: "79000000-0000-4000-8000-000000000001",
  });

  assert.deepEqual(result, {
    reclaimed: 1,
    claimed: 2,
    cleaned: 2,
    failed: 0,
    retried: 0,
  });
  assert.deepEqual(repository.removed, ["employee/one.pdf", "employee/two.pdf"]);
  assert.deepEqual(repository.completed, ["one", "two"]);
});

test("un fallo de Storage se reduce a codigo seguro y conserva el lease para retry", async () => {
  const broken = job("broken");
  const repository = new MemoryRepository([broken], new Set([broken.storagePath]));
  const result = await runSupportingDocumentCleanupWorker(repository, { workerId: "worker" });

  assert.equal(result.failed, 1);
  assert.equal(result.retried, 1);
  assert.deepEqual(repository.completed, []);
  assert.deepEqual(repository.failures, [
    { id: "broken", code: "STORAGE_REMOVE_FAILED", retryable: true },
  ]);
});

test("un fallo inesperado nunca propaga mensajes crudos al ledger", async () => {
  const repository = new MemoryRepository([job("unexpected")]);
  repository.remove = async () => { throw new Error("ruta privada y token secreto"); };
  await runSupportingDocumentCleanupWorker(repository, { workerId: "worker" });

  assert.deepEqual(repository.failures, [
    { id: "unexpected", code: "CLEANUP_FAILURE", retryable: true },
  ]);
  assert.doesNotMatch(JSON.stringify(repository.failures), /ruta privada|token secreto/);
});
