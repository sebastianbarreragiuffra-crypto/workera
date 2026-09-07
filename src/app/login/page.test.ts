import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const LOGIN_PAGE = path.join(import.meta.dirname, "page.tsx");

test("el rechazo del limite alojado se explica sin exponer detalles internos", () => {
  const source = readFileSync(LOGIN_PAGE, "utf8");

  assert.match(source, /error === "rate-limit"/);
  assert.match(source, /Demasiados intentos\. Espera unos minutos antes de volver a probar\./);
});
