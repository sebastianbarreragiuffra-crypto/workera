import assert from "node:assert/strict";
import test from "node:test";
import { parseExpenseAccountingPayload } from "./payload";
import { validAccountingPayload } from "./fixture";

test("acepta el snapshot contable v1 consistente", () => {
  const payload = parseExpenseAccountingPayload(validAccountingPayload);
  assert.equal(payload.report.totalAmount, 11900);
  assert.equal(payload.lines.length, 1);
});

test("rechaza moneda mezclada y totales de línea manipulados", () => {
  const currency = structuredClone(validAccountingPayload);
  currency.lines[0].currency = "USD";
  assert.throws(() => parseExpenseAccountingPayload(currency));

  const total = structuredClone(validAccountingPayload);
  total.lines[0].totalAmount = 11899;
  assert.throws(() => parseExpenseAccountingPayload(total));
});

test("rechaza un total de cabecera distinto a la suma de líneas", () => {
  const payload = structuredClone(validAccountingPayload);
  payload.report.totalAmount = 1;
  assert.throws(() => parseExpenseAccountingPayload(payload));
});

test("el contrato es cerrado: no acepta campos secretos o bancarios agregados", () => {
  const payload = structuredClone(validAccountingPayload) as typeof validAccountingPayload & { accessToken?: string };
  payload.accessToken = "secret";
  assert.throws(() => parseExpenseAccountingPayload(payload));
});
