import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ExpenseFileScanError } from "./errors";
import type {
  ClaimedExpenseFileScan,
  ExpenseFileScanRepository,
} from "./repository";
import { FixtureExpenseFileScanner, type ExpenseFileScanner } from "./scanner";
import { runExpenseFileScanWorker } from "./worker";

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function checksum(value: ArrayBuffer): string {
  return createHash("sha256").update(new Uint8Array(value)).digest("hex");
}

function job(id: string, body: ArrayBuffer): ClaimedExpenseFileScan {
  return {
    captureId: id,
    companyId: "78000000-0000-4000-8000-00000000000a",
    storagePath: `company/captures/${id}.pdf`,
    mimeType: "application/pdf",
    checksumSha256: checksum(body),
    source: "EMAIL",
    attempt: 1,
  };
}

class MemoryRepository implements ExpenseFileScanRepository {
  readonly completed: Array<{ id: string; verdict: string; code: string }> = [];
  readonly failures: Array<{ id: string; code: string; retryable: boolean }> = [];

  constructor(
    readonly jobs: ClaimedExpenseFileScan[],
    readonly bodies: Map<string, ArrayBuffer>,
  ) {}

  async reclaim(): Promise<number> { return 2; }
  async claim(): Promise<ClaimedExpenseFileScan[]> { return this.jobs; }
  async download(path: string): Promise<ArrayBuffer> { return this.bodies.get(path)!; }
  async complete(
    captureId: string,
    _workerId: string,
    _scanner: string,
    verdict: { verdict: "CLEAN" | "REJECTED"; resultCode: string },
  ): Promise<void> {
    this.completed.push({ id: captureId, verdict: verdict.verdict, code: verdict.resultCode });
  }
  async fail(
    captureId: string,
    _workerId: string,
    _scanner: string,
    resultCode: string,
    retryable: boolean,
  ): Promise<boolean> {
    this.failures.push({ id: captureId, code: resultCode, retryable });
    return retryable;
  }
}

test("canarios limpio e infectado recorren leases y veredictos sin PII", async () => {
  const clean = bytes("archivo-sintetico-limpio");
  const rejected = bytes("prefijo GESTORA_TEST_MALWARE_CANARY sufijo");
  const jobs = [job("clean", clean), job("rejected", rejected)];
  const repository = new MemoryRepository(jobs, new Map([
    [jobs[0].storagePath, clean],
    [jobs[1].storagePath, rejected],
  ]));

  const summary = await runExpenseFileScanWorker(
    repository,
    new FixtureExpenseFileScanner(),
    { workerId: "78000000-0000-4000-8000-000000000999" },
  );
  assert.deepEqual(summary, {
    reclaimed: 2,
    claimed: 2,
    clean: 1,
    rejected: 1,
    failed: 0,
    retried: 0,
  });
  assert.deepEqual(repository.completed, [
    { id: "clean", verdict: "CLEAN", code: "NO_TEST_CANARY" },
    { id: "rejected", verdict: "REJECTED", code: "TEST_CANARY_DETECTED" },
  ]);
});

test("una huella distinta nunca llega al proveedor y termina sin retry", async () => {
  const body = bytes("objeto-alterado");
  const claimed = job("mismatch", body);
  claimed.checksumSha256 = "0".repeat(64);
  const repository = new MemoryRepository([claimed], new Map([[claimed.storagePath, body]]));
  let scannerCalls = 0;
  const scanner: ExpenseFileScanner = {
    name: "fixture-scanner-v1",
    async scan() {
      scannerCalls += 1;
      return { verdict: "CLEAN", resultCode: "NO_TEST_CANARY" };
    },
  };

  const summary = await runExpenseFileScanWorker(repository, scanner, { workerId: "worker" });
  assert.equal(scannerCalls, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.retried, 0);
  assert.deepEqual(repository.failures, [{ id: "mismatch", code: "CHECKSUM_MISMATCH", retryable: false }]);
});

test("un error desconocido del proveedor se reduce a código seguro y reintentable", async () => {
  const body = bytes("archivo-sintetico");
  const claimed = job("provider-error", body);
  const repository = new MemoryRepository([claimed], new Map([[claimed.storagePath, body]]));
  const scanner: ExpenseFileScanner = {
    name: "fixture-scanner-v1",
    async scan() { throw new Error("token-secreto respuesta cruda"); },
  };

  const summary = await runExpenseFileScanWorker(repository, scanner, { workerId: "worker" });
  assert.equal(summary.failed, 1);
  assert.equal(summary.retried, 1);
  assert.deepEqual(repository.failures, [{ id: "provider-error", code: "SCANNER_FAILURE", retryable: true }]);
  assert.doesNotMatch(JSON.stringify(repository.failures), /token-secreto|respuesta cruda/);
});

test("un identificador de scanner no sanitizable falla antes de reclamar archivos", async () => {
  const repository = new MemoryRepository([], new Map());
  const scanner: ExpenseFileScanner = {
    name: "scanner con espacios y token",
    async scan() { return { verdict: "CLEAN", resultCode: "OK" }; },
  };
  await assert.rejects(
    runExpenseFileScanWorker(repository, scanner),
    (error) => error instanceof ExpenseFileScanError
      && error.code === "SCANNER_CONFIGURATION"
      && error.retryable === false,
  );
});
