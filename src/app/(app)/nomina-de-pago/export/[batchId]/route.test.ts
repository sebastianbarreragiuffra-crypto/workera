import { test } from "node:test";
import assert from "node:assert/strict";
import { isUuid } from "./route";

/**
 * `batchId` viene de la URL y se interpola en el header `Content-Disposition`.
 * Este filtro es lo único que separa ese header de una cadena arbitraria.
 */

test("isUuid: acepta un UUID real, en minúsculas o mayúsculas", () => {
  assert.equal(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), true);
  assert.equal(isUuid("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), true);
});

test("isUuid: rechaza comillas -- impedían inventar un segundo filename en el header", () => {
  assert.equal(isUuid('x".xlsx"; filename="evil.exe'), false);
  assert.equal(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301"'), false);
});

test("isUuid: rechaza saltos de línea -- Node aborta el header y la descarga daba 500", () => {
  assert.equal(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301\r\nX-Injected: 1"), false);
  assert.equal(isUuid("\n"), false);
});

test("isUuid: rechaza formas casi correctas", () => {
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c330"), false, "un dígito de menos");
  assert.equal(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c33011"), false, "un dígito de más");
  assert.equal(isUuid("3f2504e04f8941d39a0c0305e82c3301"), false, "sin guiones");
  assert.equal(isUuid("zf2504e0-4f89-41d3-9a0c-0305e82c3301"), false, "carácter no hexadecimal");
  assert.equal(isUuid(" 3f2504e0-4f89-41d3-9a0c-0305e82c3301 "), false, "con espacios alrededor");
});
