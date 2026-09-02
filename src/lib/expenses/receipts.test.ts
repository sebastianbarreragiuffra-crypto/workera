import assert from "node:assert/strict";
import test from "node:test";
import { EXPENSE_RECEIPT_MAX_BYTES, validateExpenseReceiptFile } from "./receipts";

test("acepta PDF, JPEG y PNG solo cuando la firma coincide", async () => {
  const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "boleta.pdf", { type: "application/pdf" });
  const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "boleta.jpg", { type: "image/jpeg" });
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "boleta.png", { type: "image/png" });

  assert.deepEqual((await validateExpenseReceiptFile(pdf)).extension, "pdf");
  assert.deepEqual((await validateExpenseReceiptFile(jpeg)).extension, "jpg");
  assert.deepEqual((await validateExpenseReceiptFile(png)).extension, "png");
});

test("rechaza un ejecutable disfrazado con MIME de PDF", async () => {
  const disguised = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], "boleta.pdf", { type: "application/pdf" });
  const result = await validateExpenseReceiptFile(disguised);
  assert.equal(result.ok, false);
  assert.match(result.message, /no coincide/i);
});

test("rechaza formatos no admitidos y archivos vacíos", async () => {
  assert.equal((await validateExpenseReceiptFile(new File([], "vacío.pdf", { type: "application/pdf" }))).ok, false);
  assert.equal((await validateExpenseReceiptFile(new File(["texto"], "boleta.txt", { type: "text/plain" }))).ok, false);
});

test("rechaza comprobantes mayores a 10 MiB antes de procesarlos", async () => {
  const oversized = new File([new Uint8Array(EXPENSE_RECEIPT_MAX_BYTES + 1)], "boleta.pdf", { type: "application/pdf" });
  const result = await validateExpenseReceiptFile(oversized);
  assert.equal(result.ok, false);
  assert.match(result.message, /10 MB/);
});
