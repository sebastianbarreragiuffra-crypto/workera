import assert from "node:assert/strict";
import test from "node:test";
import { attachmentContentDisposition, privateAttachmentHeaders } from "./private-download";

test("Content-Disposition neutraliza controles/comillas y conserva UTF-8", () => {
  const malicious = attachmentContentDisposition("\r\nmalicioso\".xlsx");
  assert.ok(!malicious.includes("\r"));
  assert.ok(!malicious.includes("\n"));
  assert.match(malicious, /^attachment; filename="malicioso_\.xlsx";/);

  const unicode = attachmentContentDisposition("nómina septiembre.xlsx");
  assert.match(unicode, /filename="nomina septiembre\.xlsx"/);
  assert.match(unicode, /filename\*=UTF-8''n%C3%B3mina%20septiembre\.xlsx/);
});

test("archivo privado siempre se fuerza como adjunto sin cache ni render activo", () => {
  const headers = privateAttachmentHeaders("nomina.xlsx", 2048, { limit: 20, remaining: 19 });
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.match(headers["Content-Disposition"], /^attachment;/);
  assert.equal(headers["Content-Length"], "2048");
  assert.equal(headers["Content-Security-Policy"], "sandbox");
  assert.equal(headers["Cache-Control"], "private, no-store, max-age=0");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(headers["RateLimit-Limit"], "20");
  assert.equal(headers["RateLimit-Remaining"], "19");
});
