import "server-only";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertExpenseBankUploadHeaders,
  assertSameOrigin,
  EXPENSE_BANK_UPLOAD_IDLE_TIMEOUT_MS,
  EXPENSE_BANK_UPLOAD_TOTAL_TIMEOUT_MS,
  ExpenseBankUploadHttpError,
  readRequestBodyWithLimit,
} from "./http";

const APP_ROOT = path.resolve(import.meta.dirname, "..", "..", "app");
const COMPONENT_ROOT = path.resolve(import.meta.dirname, "..", "..", "components", "expenses");
const SOURCE_ROOT = path.resolve(import.meta.dirname, "..", "..");

function request(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("https://gestora.example/api/expenses/arcotex/bank-import", {
    method: "POST",
    headers: { origin: "https://gestora.example", "content-type": "text/csv", ...headers },
    body,
  });
}

test("solo acepta el origen exacto de la aplicación", () => {
  assert.doesNotThrow(() => assertSameOrigin(request("fecha,monto")));
  assert.throws(
    () => assertSameOrigin(request("fecha,monto", { origin: "https://evil.example" })),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 403
  );
  const missingOrigin = request("fecha,monto");
  missingOrigin.headers.delete("origin");
  assert.throws(
    () => assertSameOrigin(missingOrigin),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 403
  );
});

test("acepta text/csv y rechaza otros tipos antes de leer el cuerpo", () => {
  assert.doesNotThrow(() => assertExpenseBankUploadHeaders(request("a,b"), 100));
  assert.throws(
    () => assertExpenseBankUploadHeaders(request("a,b", { "content-type": "multipart/form-data" }), 100),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 415
  );
});

test("un Content-Length inválido o sobredimensionado falla cerrado", () => {
  assert.throws(
    () => assertExpenseBankUploadHeaders(request("x", { "content-length": "no-numero" }), 10),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 400
  );
  assert.throws(
    () => assertExpenseBankUploadHeaders(request("x", { "content-length": "11" }), 10),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 413
  );
});

test("lee un CSV pequeño sin convertir el Request completo a FormData", async () => {
  const bytes = await readRequestBodyWithLimit(request("fecha,monto\n2026-09-01,100"), 100);
  assert.equal(new TextDecoder().decode(bytes), "fecha,monto\n2026-09-01,100");
});

test("corta el stream apenas supera el máximo aunque no exista Content-Length", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  const streamed = new Request("https://gestora.example/api/expenses/arcotex/bank-import", {
    method: "POST",
    headers: { origin: "https://gestora.example", "content-type": "text/csv" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readRequestBodyWithLimit(streamed, 10),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 413
  );
});

test("cancela una carga que deja de enviar bytes y responde timeout", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const streamed = new Request("https://gestora.example/api/expenses/arcotex/bank-import", {
    method: "POST",
    headers: { origin: "https://gestora.example", "content-type": "text/csv" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readRequestBodyWithLimit(streamed, 100, { totalTimeoutMs: 50, idleTimeoutMs: 5 }),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 408
  );
  assert.equal(cancelled, true);
});

test("corta por duración total aunque el emisor siga enviando bytes", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
  });
  const streamed = new Request("https://gestora.example/api/expenses/arcotex/bank-import", {
    method: "POST",
    headers: { origin: "https://gestora.example", "content-type": "text/csv" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  let tick = 0;

  await assert.rejects(
    readRequestBodyWithLimit(streamed, 1_000, {
      totalTimeoutMs: 4,
      idleTimeoutMs: 100,
      now: () => tick++,
    }),
    (error) => error instanceof ExpenseBankUploadHttpError && error.status === 408
  );
});

test("los límites de producción acotan inactividad y duración total", () => {
  assert.equal(EXPENSE_BANK_UPLOAD_IDLE_TIMEOUT_MS, 5_000);
  assert.equal(EXPENSE_BANK_UPLOAD_TOTAL_TIMEOUT_MS, 30_000);
});

test("el endpoint autentica y reserva cuota antes de leer el primer byte", () => {
  const routePath = path.join(APP_ROOT, "api", "expenses", "[companySlug]", "bank-import", "route.ts");
  const source = readFileSync(routePath, "utf8");
  const contextIndex = source.indexOf("getExpenseCompanyContextFromClient");
  const claimIndex = source.indexOf("claimExpenseBankUploadWithServiceRole({");
  const readIndex = source.indexOf("readRequestBodyWithLimit(request");
  assert.ok(contextIndex >= 0 && claimIndex > contextIndex && readIndex > claimIndex);
  assert.doesNotMatch(source, /request\.(formData|arrayBuffer|text)\(/);
  assert.match(source, /export const maxDuration = 60/);
});

test("el proxy no intercepta ni materializa el body del upload bancario", () => {
  const proxy = readFileSync(path.join(SOURCE_ROOT, "proxy.ts"), "utf8");
  assert.match(proxy, /api\/expenses\/\[\^\/\]\+\/bank-import\$/);
  assert.doesNotMatch(proxy, /bank-import\(\?:\/\|\$\)/);
  assert.match(proxy, /esa ruta\s+\* autentica sesión, empresa, rol y origen/);
});

test("la pantalla envía el File crudo y ya no expone una Server Action multipart", () => {
  const component = readFileSync(path.join(COMPONENT_ROOT, "ExpenseBankReconciliationForms.tsx"), "utf8");
  const actions = readFileSync(
    path.join(APP_ROOT, "(expenses)", "empresas", "[companySlug]", "rendiciones", "actions.ts"),
    "utf8"
  );
  assert.match(component, /body:\s*file/);
  assert.match(component, /"Content-Type":\s*"text\/csv"/);
  assert.doesNotMatch(component, /importExpenseBankStatementAction/);
  assert.doesNotMatch(actions, /export async function importExpenseBankStatementAction/);
});
