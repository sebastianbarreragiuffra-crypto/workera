import "server-only";

import { test } from "node:test";
import assert from "node:assert/strict";
import { expenseEmailAddress, getExpenseEmailDomain, getExpenseEmailProviderConfig } from "./config";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("la configuración falla cerrada si falta una credencial o el dominio no es un hostname", () => {
  const previous = {
    api: process.env.RESEND_API_KEY,
    secret: process.env.RESEND_WEBHOOK_SECRET,
    domain: process.env.RESEND_RECEIVING_DOMAIN,
  };
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
  process.env.RESEND_RECEIVING_DOMAIN = "https://receipts.example.com/path";
  try {
    assert.equal(getExpenseEmailDomain(), null);
    assert.equal(getExpenseEmailProviderConfig(), null);
  } finally {
    restore("RESEND_API_KEY", previous.api);
    restore("RESEND_WEBHOOK_SECRET", previous.secret);
    restore("RESEND_RECEIVING_DOMAIN", previous.domain);
  }
});

test("el conector solo se habilita con el literal true y forma la dirección opaca", () => {
  const names = ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "RESEND_RECEIVING_DOMAIN", "EXPENSE_EMAIL_CAPTURE_ENABLED"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
  process.env.RESEND_RECEIVING_DOMAIN = "Receipts.Example.com.";
  process.env.EXPENSE_EMAIL_CAPTURE_ENABLED = "TRUE";
  try {
    assert.equal(getExpenseEmailProviderConfig()?.enabled, false);
    process.env.EXPENSE_EMAIL_CAPTURE_ENABLED = "true";
    assert.equal(getExpenseEmailProviderConfig()?.enabled, true);
    assert.equal(expenseEmailAddress("ABC", "Receipts.Example.com"), "comprobantes+abc@receipts.example.com");
  } finally {
    for (const name of names) restore(name, previous[name]);
  }
});
