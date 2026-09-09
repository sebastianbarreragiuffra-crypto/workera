import assert from "node:assert/strict";
import test from "node:test";
import type { FullResult, TestCase, TestResult } from "@playwright/test/reporter";
import SanitizedHostedReporter from "./sanitized-reporter";

test("el reporter nunca imprime errores, URLs, cuerpos ni adjuntos", () => {
  const reporter = new SanitizedHostedReporter();
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    reporter.onTestEnd(
      { titlePath: () => ["hosted-access.spec.ts", "RRHH", "caso estático"] } as TestCase,
      {
        status: "failed",
        error: { message: "SECRETO cuerpo https://staging.invalid/empleados/uuid" },
        attachments: [{ name: "trace", contentType: "text/plain", body: Buffer.from("PII") }],
      } as TestResult,
    );
    reporter.onEnd({ status: "failed" } as FullResult);
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join("");
  assert.match(output, /failed: RRHH \/ caso estático/);
  assert.match(output, /resultado global: failed/);
  assert.doesNotMatch(output, /SECRETO|https:|uuid|PII|trace/);
});
