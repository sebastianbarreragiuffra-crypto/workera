import "server-only";

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedResendAttachmentUrl, resolveSingleExpenseAliasToken, safeAttachmentFilename } from "./recipients";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

test("resuelve un único token válido solo en el dominio configurado", () => {
  assert.equal(resolveSingleExpenseAliasToken([
    `Comprobantes <comprobantes+${TOKEN}@receipts.example.com>`,
    "otro@example.com",
  ], "receipts.example.com"), TOKEN);
  assert.equal(resolveSingleExpenseAliasToken([`comprobantes+${TOKEN}@evil.example`], "receipts.example.com"), null);
});

test("rechaza destinatarios ambiguos, alias mal formados y UUID no válidos", () => {
  assert.equal(resolveSingleExpenseAliasToken([
    `comprobantes+${TOKEN}@receipts.example.com`,
    "comprobantes+223e4567-e89b-42d3-a456-426614174000@receipts.example.com",
  ], "receipts.example.com"), null);
  assert.equal(resolveSingleExpenseAliasToken(["comprobantes+not-a-uuid@receipts.example.com"], "receipts.example.com"), null);
});

test("solo permite descargas HTTPS desde el host exacto de adjuntos de Resend", () => {
  assert.equal(isTrustedResendAttachmentUrl("https://inbound-cdn.resend.com/file/signed"), true);
  assert.equal(isTrustedResendAttachmentUrl("http://inbound-cdn.resend.com/file"), false);
  assert.equal(isTrustedResendAttachmentUrl("https://inbound-cdn.resend.com.evil.example/file"), false);
  assert.equal(isTrustedResendAttachmentUrl("https://user@inbound-cdn.resend.com/file"), false);
});

test("el nombre del adjunto elimina rutas y caracteres de control", () => {
  assert.equal(safeAttachmentFilename("../../boleta.pdf", "pdf"), "boleta.pdf");
  assert.equal(safeAttachmentFilename("..\\factura\u0000.png", "png"), "factura.png");
  assert.equal(safeAttachmentFilename(undefined, "jpg"), "comprobante.jpg");
});
