import { test } from "node:test";
import assert from "node:assert/strict";
import { AzureDocumentIntelligenceClient } from "./azure-document-intelligence";
import type { AzureExpenseOcrConfig } from "./config";
import { ExpenseOcrError } from "./errors";

const config: AzureExpenseOcrConfig = {
  enabled: true,
  provider: "azure-document-intelligence",
  endpoint: new URL("https://demo.cognitiveservices.azure.com/"),
  apiKey: "fake-secret-never-log",
  requestTimeoutMs: 1000,
};

test("inicio usa API GA 2024-11-30 y modelo prebuilt-receipt", async () => {
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  const client = new AzureDocumentIntelligenceClient(config, {
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 202, headers: { "Operation-Location": "https://demo.cognitiveservices.azure.com/documentintelligence/operations/abc" } });
    },
  });
  const result = await client.startReceiptAnalysis(new Uint8Array([1, 2]).buffer, "application/pdf");
  assert.equal(result.state, "pending");
  assert.match(requestedUrl, /prebuilt-receipt:analyze/);
  assert.match(requestedUrl, /api-version=2024-11-30/);
  assert.equal(requestedHeaders?.get("ocp-apim-subscription-key"), "fake-secret-never-log");
});

test("Operation-Location fuera del origen configurado se rechaza para evitar SSRF", async () => {
  const client = new AzureDocumentIntelligenceClient(config, {
    fetch: async () => new Response(null, { status: 202, headers: { "Operation-Location": "https://evil.example/steal" } }),
  });
  await assert.rejects(
    client.startReceiptAnalysis(new ArrayBuffer(1), "image/png"),
    (error) => error instanceof ExpenseOcrError && error.category === "INVALID_PROVIDER_RESPONSE" && !error.message.includes(config.apiKey)
  );
});

test("polling distingue operación pendiente y completada", async () => {
  const responses = [
    new Response(JSON.stringify({ status: "running" }), { status: 200 }),
    new Response(JSON.stringify({ status: "succeeded", analyzeResult: { documents: [] } }), { status: 200 }),
  ];
  const client = new AzureDocumentIntelligenceClient(config, { fetch: async () => responses.shift()! });
  const operation = "https://demo.cognitiveservices.azure.com/documentintelligence/operations/abc";
  assert.equal((await client.pollReceiptAnalysis(operation)).state, "pending");
  assert.equal((await client.pollReceiptAnalysis(operation)).state, "succeeded");
});

test("429 y 5xx son retryable; autenticación inválida no lo es", async () => {
  for (const [status, retryable] of [[429, true], [503, true], [401, false]] as const) {
    const client = new AzureDocumentIntelligenceClient(config, { fetch: async () => new Response(null, { status }) });
    await assert.rejects(
      client.pollReceiptAnalysis("https://demo.cognitiveservices.azure.com/documentintelligence/operations/abc"),
      (error) => error instanceof ExpenseOcrError && error.retryable === retryable
    );
  }
});
