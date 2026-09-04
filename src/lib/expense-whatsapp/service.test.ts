import "server-only";

import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExpenseWhatsappProviderConfig } from "./config";
import { isTrustedWhatsappMediaUrl, normalizeWhatsappPairingCode, verifyMetaWebhookSignature } from "./service";

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

test("la firma Meta se calcula sobre los bytes crudos y exige sha256 exacto", () => {
  const body = new TextEncoder().encode('{"ok":true}');
  const signature = `sha256=${createHmac("sha256", CONFIG.appSecret).update(body).digest("hex")}`;
  assert.equal(verifyMetaWebhookSignature(body, signature, CONFIG.appSecret), true);
  assert.equal(verifyMetaWebhookSignature(body, "sha256=" + "0".repeat(64), CONFIG.appSecret), false);
  assert.equal(verifyMetaWebhookSignature(body, null, CONFIG.appSecret), false);
});

test("el código de vínculo acepta solo el comando y 96 bits hexadecimales", () => {
  assert.equal(normalizeWhatsappPairingCode("VINCULAR ABCD-EF01-2345-6789-ABCD-EF01"), "ABCDEF0123456789ABCDEF01");
  assert.equal(normalizeWhatsappPairingCode("hola ABCD-EF01-2345-6789-ABCD-EF01"), null);
  assert.equal(normalizeWhatsappPairingCode("VINCULAR 1234"), null);
});

test("la URL temporal exige HTTPS y un hostname exacto de la allowlist", () => {
  assert.equal(isTrustedWhatsappMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/x", CONFIG), true);
  assert.equal(isTrustedWhatsappMediaUrl("https://lookaside.fbsbx.com.evil.example/x", CONFIG), false);
  assert.equal(isTrustedWhatsappMediaUrl("http://lookaside.fbsbx.com/x", CONFIG), false);
  assert.equal(isTrustedWhatsappMediaUrl("https://user:pass@lookaside.fbsbx.com/x", CONFIG), false);
});
