import "server-only";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getExpenseWhatsappProviderConfig, whatsappLink } from "./config";

const NAMES = [
  "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_NUMBER", "WHATSAPP_GRAPH_API_VERSION",
  "WHATSAPP_LINK_SECRET", "WHATSAPP_MEDIA_HOSTS", "EXPENSE_WHATSAPP_CAPTURE_ENABLED",
] as const;

function withValidEnvironment(run: () => void): void {
  const previous = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    WHATSAPP_APP_SECRET: "app-secret-1234567890",
    WHATSAPP_VERIFY_TOKEN: "verify-token-1234567890",
    WHATSAPP_ACCESS_TOKEN: "access-token-1234567890",
    WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    WHATSAPP_BUSINESS_NUMBER: "+56911112222",
    WHATSAPP_GRAPH_API_VERSION: "v24.0",
    WHATSAPP_LINK_SECRET: "separate-link-secret-1234567890123456",
    WHATSAPP_MEDIA_HOSTS: "lookaside.fbsbx.com",
  });
  try { run(); } finally {
    for (const name of NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("la configuración falla cerrada si falta la allowlist de descarga", () => {
  withValidEnvironment(() => {
    delete process.env.WHATSAPP_MEDIA_HOSTS;
    assert.equal(getExpenseWhatsappProviderConfig(), null);
  });
});

test("la configuración rechaza secretos débiles o un hostname inválido", () => {
  withValidEnvironment(() => {
    process.env.WHATSAPP_LINK_SECRET = "corto";
    assert.equal(getExpenseWhatsappProviderConfig(), null);
    process.env.WHATSAPP_LINK_SECRET = "separate-link-secret-1234567890123456";
    process.env.WHATSAPP_MEDIA_HOSTS = "lookaside.fbsbx.com,https://evil.example/path";
    assert.equal(getExpenseWhatsappProviderConfig(), null);
  });
});

test("el conector solo se habilita con true literal y conserva hosts exactos", () => {
  withValidEnvironment(() => {
    process.env.EXPENSE_WHATSAPP_CAPTURE_ENABLED = "TRUE";
    assert.equal(getExpenseWhatsappProviderConfig()?.enabled, false);
    process.env.EXPENSE_WHATSAPP_CAPTURE_ENABLED = "true";
    const config = getExpenseWhatsappProviderConfig();
    assert.equal(config?.enabled, true);
    assert.deepEqual([...config!.mediaHosts], ["lookaside.fbsbx.com"]);
  });
});

test("el enlace no expone secretos y precarga el código de un solo uso", () => {
  assert.equal(
    whatsappLink("+56 9 1111 2222", "ABCD-EFGH"),
    "https://wa.me/56911112222?text=VINCULAR%20ABCD-EFGH"
  );
});
