import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMfaQrCodeDataUri } from "./qr-code";

test("conserva intacto el data URI SVG que entrega Supabase Auth", () => {
  const qrCode = "data:image/svg+xml;utf-8,<svg xmlns='http://www.w3.org/2000/svg'></svg>";

  assert.equal(normalizeMfaQrCodeDataUri(qrCode), qrCode);
});

test("rechaza URLs y otros tipos de data URI", () => {
  for (const unsafeValue of [
    "https://example.com/qr.svg",
    "data:text/html,<script>alert(1)</script>",
    "data:image/png;base64,AAAA",
  ]) {
    assert.throws(() => normalizeMfaQrCodeDataUri(unsafeValue));
  }
});

test("rechaza el formato doblemente codificado que rompía el QR", () => {
  const broken = `data:image/svg+xml;utf-8,${encodeURIComponent(
    "data:image/svg+xml;utf-8,<svg></svg>"
  )}`;

  assert.throws(() => normalizeMfaQrCodeDataUri(broken));
});
