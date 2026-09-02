import { test } from "node:test";
import assert from "node:assert/strict";
import { readExpenseOcrConfig } from "./config";
import { ExpenseOcrError } from "./errors";

test("OCR permanece fail-closed salvo que EXPENSE_OCR_ENABLED sea exactamente true", () => {
  assert.deepEqual(readExpenseOcrConfig({ EXPENSE_OCR_ENABLED: "TRUE" }), { enabled: false, provider: "disabled" });
  assert.deepEqual(readExpenseOcrConfig({ EXPENSE_OCR_ENABLED: "false" }), { enabled: false, provider: "disabled" });
});

test("OCR habilitado exige proveedor Azure, endpoint HTTPS y credencial", () => {
  assert.throws(
    () => readExpenseOcrConfig({ EXPENSE_OCR_ENABLED: "true", EXPENSE_OCR_PROVIDER: "disabled" }),
    (error) => error instanceof ExpenseOcrError && error.category === "CONFIGURATION" && !error.retryable
  );
  assert.throws(
    () => readExpenseOcrConfig({ EXPENSE_OCR_ENABLED: "true", EXPENSE_OCR_PROVIDER: "azure-document-intelligence", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "http://example.test", AZURE_DOCUMENT_INTELLIGENCE_KEY: "fake" }),
    /HTTPS/
  );
});

test("configuración Azure válida normaliza el endpoint y timeout", () => {
  const config = readExpenseOcrConfig({
    EXPENSE_OCR_ENABLED: "true",
    EXPENSE_OCR_PROVIDER: "azure-document-intelligence",
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.cognitiveservices.azure.com/",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "fake-key-for-tests",
    EXPENSE_OCR_REQUEST_TIMEOUT_MS: "2000",
  });
  assert.equal(config.enabled, true);
  if (config.enabled) {
    assert.equal(config.endpoint.href, "https://example.cognitiveservices.azure.com/");
    assert.equal(config.requestTimeoutMs, 2000);
  }
});
