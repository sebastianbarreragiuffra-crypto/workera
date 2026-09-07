import assert from "node:assert/strict";
import test from "node:test";
import { CloudmersiveAdvancedScanner } from "./cloudmersive";
import { ExpenseFileScanError } from "./errors";

const config = {
  enabled: true,
  provider: "cloudmersive-advanced",
  origin: "https://scanner-private.example",
  apiKey: "fake-cloudmersive-key-for-tests-000000000000",
  timeoutMs: 1000,
  maxFilesPerRun: 10,
  maxRuntimeMs: 45000,
} as const;

const input = {
  bytes: new TextEncoder().encode("synthetic-pdf").buffer as ArrayBuffer,
  mimeType: "application/pdf",
  checksumSha256: "a".repeat(64),
};

test("envia bytes al origen exacto con politica restrictiva y nombre sintetico", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const scanner = new CloudmersiveAdvancedScanner(config, async (url, init) => {
    observedUrl = String(url);
    observedInit = init;
    return Response.json({ CleanResult: true, FoundViruses: [] });
  });
  assert.deepEqual(await scanner.scan(input), { verdict: "CLEAN", resultCode: "CLOUDMERSIVE_CLEAN" });
  assert.equal(observedUrl, "https://scanner-private.example/virus/scan/file/advanced");
  assert.equal(observedInit?.method, "POST");
  assert.equal(observedInit?.redirect, "error");
  assert.equal(new Headers(observedInit?.headers).get("apikey"), config.apiKey);
  assert.equal(new Headers(observedInit?.headers).get("allowexecutables"), "false");
  assert.equal(new Headers(observedInit?.headers).get("restrictfiletypes"), ".pdf,.jpg,.jpeg,.png");
  assert.ok(observedInit?.body instanceof FormData);
  const form = observedInit.body as FormData;
  const file = form.get("inputFile");
  assert.ok(file instanceof File);
  assert.equal(file.name, "quarantined.pdf");
  assert.equal(file.type, "application/pdf");
  assert.doesNotMatch(file.name, /company|employee|receipt|[a-f0-9]{64}/i);
});

test("reduce malware y politicas inseguras a codigos genericos", async () => {
  const malware = new CloudmersiveAdvancedScanner(config, async () => Response.json({
    CleanResult: false,
    FoundViruses: [{ FileName: "persona-rut.pdf", VirusName: "EICAR secret detail" }],
  }));
  assert.deepEqual(await malware.scan(input), { verdict: "REJECTED", resultCode: "MALWARE_DETECTED" });

  const policy = new CloudmersiveAdvancedScanner(config, async () => Response.json({
    CleanResult: true,
    FoundViruses: [],
    ContainsScript: true,
  }));
  assert.deepEqual(await policy.scan(input), { verdict: "REJECTED", resultCode: "POLICY_REJECTED" });
});

test("clasifica autenticacion, rate limit y respuestas invalidas sin filtrar payload", async () => {
  const unauthorized = new CloudmersiveAdvancedScanner(config, async () => new Response("secret", { status: 401 }));
  await assert.rejects(unauthorized.scan(input), (error) => error instanceof ExpenseFileScanError
    && error.code === "SCANNER_CONFIGURATION" && error.retryable && error.retryAfterSeconds === 300);

  const limited = new CloudmersiveAdvancedScanner(config, async () => new Response(null, {
    status: 429,
    headers: { "Retry-After": "120" },
  }));
  await assert.rejects(limited.scan(input), (error) => error instanceof ExpenseFileScanError
    && error.code === "SCANNER_FAILURE" && error.retryable && error.retryAfterSeconds === 120);

  const invalid = new CloudmersiveAdvancedScanner(config, async () => Response.json({
    CleanResult: "yes",
    FoundViruses: [{ VirusName: "do-not-leak" }],
  }));
  await assert.rejects(invalid.scan(input), (error) => error instanceof ExpenseFileScanError
    && error.code === "SCANNER_FAILURE" && error.retryable
    && !error.message.includes("do-not-leak"));
});

test("timeout extremo a extremo y respuesta sobredimensionada fallan cerrados", async () => {
  const timeoutScanner = new CloudmersiveAdvancedScanner({ ...config, timeoutMs: 5 }, async (_url, init) =>
    new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(timeoutScanner.scan(input), (error) => error instanceof ExpenseFileScanError
    && error.retryable && error.retryAfterSeconds === 30);

  const oversized = new CloudmersiveAdvancedScanner(config, async () => new Response(
    JSON.stringify({ CleanResult: true, padding: "x".repeat(70 * 1024) }),
    { headers: { "content-type": "application/json" } },
  ));
  await assert.rejects(oversized.scan(input), (error) => error instanceof ExpenseFileScanError
    && error.retryable && error.retryAfterSeconds === 30);
});

test("acepta los dos media types JSON documentados y rechaza XML", async () => {
  for (const contentType of ["application/json; charset=utf-8", "text/json"]) {
    const scanner = new CloudmersiveAdvancedScanner(config, async () => new Response(
      JSON.stringify({ CleanResult: true, FoundViruses: [] }),
      { headers: { "content-type": contentType } },
    ));
    assert.equal((await scanner.scan(input)).verdict, "CLEAN");
  }
  const xml = new CloudmersiveAdvancedScanner(config, async () => new Response(
    "<VirusScanResult><CleanResult>true</CleanResult></VirusScanResult>",
    { headers: { "content-type": "application/xml" } },
  ));
  await assert.rejects(xml.scan(input), (error) => error instanceof ExpenseFileScanError
    && error.code === "SCANNER_FAILURE" && error.retryable);
});
