import { test } from "node:test";
import assert from "node:assert/strict";
import type { EmailReceivedEvent, WebhookEventPayload } from "resend";
import type { ExpenseEmailProviderConfig } from "@/lib/expense-email/config";
import { handleExpenseEmailWebhook } from "./route";

const CONFIG: ExpenseEmailProviderConfig = {
  enabled: true,
  apiKey: "re_test",
  webhookSecret: "whsec_test",
  receivingDomain: "receipts.example.com",
};

const EVENT: EmailReceivedEvent = {
  type: "email.received",
  created_at: "2026-09-03T12:00:00Z",
  data: {
    email_id: "email-test",
    created_at: "2026-09-03T12:00:00Z",
    from: "sender@example.net",
    to: ["comprobantes+123e4567-e89b-42d3-a456-426614174000@receipts.example.com"],
    bcc: [],
    cc: [],
    received_for: [],
    message_id: "message-test",
    subject: "Boleta",
    attachments: [],
  },
};

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/api/webhooks/resend/expense-receipts", {
    method: "POST",
    body: JSON.stringify(EVENT),
    headers,
  });
}

function dependencies(overrides: Partial<Parameters<typeof handleExpenseEmailWebhook>[1]> = {}) {
  return {
    config: () => CONFIG,
    verify: () => EVENT as WebhookEventPayload,
    process: async () => ({ stored: 1, duplicate: 0, ignored: 0 }),
    ...overrides,
  };
}

test("el webhook falla cerrado si el conector está deshabilitado o incompleto", async () => {
  const response = await handleExpenseEmailWebhook(request(), dependencies({ config: () => null }));
  assert.equal(response.status, 503);
});

test("el webhook exige los tres encabezados Svix", async () => {
  const response = await handleExpenseEmailWebhook(request(), dependencies());
  assert.equal(response.status, 401);
});

test("una firma inválida se rechaza antes de procesar adjuntos", async () => {
  let processed = false;
  const response = await handleExpenseEmailWebhook(request({
    "svix-id": "id",
    "svix-timestamp": "timestamp",
    "svix-signature": "signature",
  }), dependencies({
    verify: () => { throw new Error("invalid"); },
    process: async () => { processed = true; return { stored: 0, duplicate: 0, ignored: 0 }; },
  }));
  assert.equal(response.status, 401);
  assert.equal(processed, false);
});

test("rechaza el cuerpo sobredimensionado antes de verificar la firma", async () => {
  let verified = false;
  const oversized = request({
    "svix-id": "id",
    "svix-timestamp": "timestamp",
    "svix-signature": "signature",
    "content-length": String(512 * 1024 + 1),
  });
  const response = await handleExpenseEmailWebhook(oversized, dependencies({
    verify: () => { verified = true; return EVENT; },
  }));
  assert.equal(response.status, 413);
  assert.equal(verified, false);
});

test("corta un cuerpo chunked sobredimensionado aunque no declare Content-Length", async () => {
  let verified = false;
  const oversized = new Request("https://app.example.com/api/webhooks/resend/expense-receipts", {
    method: "POST",
    body: "x".repeat(512 * 1024 + 1),
    headers: {
      "svix-id": "id",
      "svix-timestamp": "timestamp",
      "svix-signature": "signature",
    },
  });
  assert.equal(oversized.headers.get("content-length"), null);
  const response = await handleExpenseEmailWebhook(oversized, dependencies({
    verify: () => { verified = true; return EVENT; },
  }));
  assert.equal(response.status, 413);
  assert.equal(verified, false);
});

test("eventos firmados que no son email.received se aceptan sin procesar", async () => {
  let processed = false;
  const response = await handleExpenseEmailWebhook(request({
    "svix-id": "id",
    "svix-timestamp": "timestamp",
    "svix-signature": "signature",
  }), dependencies({
    verify: () => ({ type: "email.sent", created_at: EVENT.created_at, data: { email_id: "id", created_at: EVENT.created_at, from: "a@b.cl", to: ["c@d.cl"], subject: "x" } }) as WebhookEventPayload,
    process: async () => { processed = true; return { stored: 0, duplicate: 0, ignored: 0 }; },
  }));
  assert.equal(response.status, 202);
  assert.equal(processed, false);
});

test("un email.received firmado entrega un resumen mínimo", async () => {
  let deliveredProviderEventId = "";
  const response = await handleExpenseEmailWebhook(request({
    "svix-id": "id",
    "svix-timestamp": "timestamp",
    "svix-signature": "signature",
  }), dependencies({
    process: async (_event, _config, providerEventId) => {
      deliveredProviderEventId = providerEventId;
      return { stored: 1, duplicate: 0, ignored: 0 };
    },
  }));
  assert.equal(response.status, 200);
  assert.equal(deliveredProviderEventId, "id");
  assert.deepEqual(await response.json(), { accepted: true, stored: 1, duplicate: 0, ignored: 0 });
});

test("un fallo transitorio de procesamiento devuelve 500 para conservar el reintento del proveedor", async () => {
  const response = await handleExpenseEmailWebhook(request({
    "svix-id": "id",
    "svix-timestamp": "timestamp",
    "svix-signature": "signature",
  }), dependencies({
    process: async () => { throw new Error("transient"); },
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "No se pudo procesar el correo." });
});
