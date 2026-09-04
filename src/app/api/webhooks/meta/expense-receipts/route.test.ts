import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExpenseWhatsappProviderConfig } from "@/lib/expense-whatsapp/config";
import { handleExpenseWhatsappVerification, handleExpenseWhatsappWebhook } from "./route";

const CONFIG: ExpenseWhatsappProviderConfig = {
  enabled: true,
  appSecret: "app-secret",
  verifyToken: "verify-token",
  accessToken: "access-token",
  phoneNumberId: "1234567890",
  businessNumber: "+56911112222",
  graphVersion: "v24.0",
  linkSecret: "link-secret",
  mediaHosts: new Set(["lookaside.fbsbx.com"]),
};

const PAYLOAD = { object: "whatsapp_business_account", entry: [] };
const deps = (overrides: Partial<NonNullable<Parameters<typeof handleExpenseWhatsappWebhook>[1]>> = {}) => ({
  config: () => CONFIG,
  verify: () => true,
  process: async () => ({ paired: 0, stored: 1, duplicate: 0, ignored: 0 }),
  ...overrides,
});

test("GET entrega el challenge con token exacto aunque el canal siga pausado", async () => {
  const ok = await handleExpenseWhatsappVerification(new Request(
    "https://app.example.com/api/webhooks/meta/expense-receipts?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345"
  ), deps());
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  const paused = await handleExpenseWhatsappVerification(new Request(
    "https://app.example.com/api/webhooks/meta/expense-receipts?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=67890"
  ), deps({ config: () => ({ ...CONFIG, enabled: false }) }));
  assert.equal(paused.status, 200);
  assert.equal(await paused.text(), "67890");
  const denied = await handleExpenseWhatsappVerification(new Request(
    "https://app.example.com/api/webhooks/meta/expense-receipts?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345"
  ), deps());
  assert.equal(denied.status, 403);
});

test("POST falla cerrado antes de procesar si falta configuración o firma", async () => {
  let processed = false;
  const request = new Request("https://app.example.com/api/webhooks/meta/expense-receipts", {
    method: "POST", body: JSON.stringify(PAYLOAD), headers: { "x-hub-signature-256": "sha256=x" },
  });
  assert.equal((await handleExpenseWhatsappWebhook(request.clone(), deps({ config: () => null }))).status, 503);
  const response = await handleExpenseWhatsappWebhook(request, deps({
    verify: () => false,
    process: async () => { processed = true; return { paired: 0, stored: 0, duplicate: 0, ignored: 0 }; },
  }));
  assert.equal(response.status, 401);
  assert.equal(processed, false);
});

test("POST limita el cuerpo antes de verificar la firma", async () => {
  let verified = false;
  const request = new Request("https://app.example.com/api/webhooks/meta/expense-receipts", {
    method: "POST", body: "{}", headers: { "content-length": String(512 * 1024 + 1) },
  });
  const response = await handleExpenseWhatsappWebhook(request, deps({ verify: () => { verified = true; return true; } }));
  assert.equal(response.status, 413);
  assert.equal(verified, false);
});

test("POST firmado entrega un resumen mínimo sin reflejar el payload", async () => {
  const response = await handleExpenseWhatsappWebhook(new Request(
    "https://app.example.com/api/webhooks/meta/expense-receipts",
    { method: "POST", body: JSON.stringify(PAYLOAD), headers: { "x-hub-signature-256": "sha256=x" } }
  ), deps());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, paired: 0, stored: 1, duplicate: 0, ignored: 0 });
});

test("un fallo transitorio devuelve 500 para conservar el reintento de Meta", async () => {
  const response = await handleExpenseWhatsappWebhook(new Request(
    "https://app.example.com/api/webhooks/meta/expense-receipts",
    { method: "POST", body: JSON.stringify(PAYLOAD), headers: { "x-hub-signature-256": "sha256=x" } }
  ), deps({ process: async () => { throw new Error("transient"); } }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "No se pudo procesar el mensaje." });
});
