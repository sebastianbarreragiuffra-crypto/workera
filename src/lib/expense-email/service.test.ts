import { test } from "node:test";
import assert from "node:assert/strict";
import { selectProcessableExpenseEmailAttachments } from "./service";

test("filtra recursos inline antes de aplicar el máximo de diez comprobantes", () => {
  const inline = Array.from({ length: 10 }, (_, index) => ({
    id: `inline-${index}`,
    content_disposition: "inline",
    content_type: "image/png",
  }));
  const receipt = {
    id: "receipt",
    content_disposition: "attachment",
    content_type: "application/pdf",
  };

  assert.deepEqual(
    selectProcessableExpenseEmailAttachments([...inline, receipt]).map((item) => item.id),
    ["receipt"]
  );
});

test("solo selecciona los diez primeros comprobantes con formato admitido", () => {
  const valid = Array.from({ length: 12 }, (_, index) => ({
    id: `receipt-${index}`,
    content_disposition: "attachment",
    content_type: "image/jpeg; name=receipt.jpg",
  }));
  const unsupported = {
    id: "script",
    content_disposition: "attachment",
    content_type: "text/html",
  };

  assert.deepEqual(
    selectProcessableExpenseEmailAttachments([unsupported, ...valid]).map((item) => item.id),
    valid.slice(0, 10).map((item) => item.id)
  );
});
