import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAzureReceipt } from "./normalize";

test("normaliza solo campos permitidos, confianza y moneda sin conservar el payload OCR crudo", () => {
  const extraction = normalizeAzureReceipt({
    status: "succeeded",
    analyzeResult: { documents: [{ fields: {
      MerchantName: { valueString: "Hotel Uno", confidence: 0.96 },
      TransactionDate: { valueDate: "2026-08-10", confidence: 0.95 },
      Subtotal: { valueCurrency: { amount: 10000, currencyCode: "CLP" }, confidence: 0.94 },
      TotalTax: { valueCurrency: { amount: 1900, currencyCode: "CLP" }, confidence: 0.93 },
      Total: { valueCurrency: { amount: 11900, currencyCode: "CLP" }, confidence: 0.97 },
      IrrelevantRawField: { content: "texto completo que no debe persistirse" },
    } }] },
  }, { expenseDate: "2026-08-10", merchantName: "Hotel Uno", netAmount: 10000, taxAmount: 1900, totalAmount: 11900, currencyCode: "CLP" });

  assert.equal(extraction.fields.total.value, 11900);
  assert.equal(extraction.fields.currencyCode.value, "CLP");
  assert.equal(extraction.requiresHumanReview, false);
  assert.equal(JSON.stringify(extraction).includes("texto completo que no debe persistirse"), false);
});

test("diferencias, campos faltantes o baja confianza fuerzan revisión humana sin cambiar lo declarado", () => {
  const extraction = normalizeAzureReceipt({
    analyzeResult: { documents: [{ fields: {
      MerchantName: { valueString: "Otro comercio", confidence: 0.4 },
      TransactionDate: { valueDate: "2026-08-11", confidence: 0.5 },
      Total: { valueCurrency: { amount: 15000 }, confidence: 0.5 },
    } }] },
  }, { expenseDate: "2026-08-10", merchantName: "Original", netAmount: 10000, taxAmount: 1900, totalAmount: 11900, currencyCode: "CLP" });

  assert.equal(extraction.requiresHumanReview, true);
  assert.ok(extraction.reviewReasons.includes("low-confidence"));
  assert.ok(extraction.reviewReasons.includes("missing:currencyCode"));
  assert.deepEqual(extraction.discrepancies.map((item) => item.field), ["merchantName", "expenseDate", "totalAmount"]);
});
