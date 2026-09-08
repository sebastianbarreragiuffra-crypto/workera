import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appLayout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

test("el shell permite saltar la navegación repetida con teclado", () => {
  assert.match(appLayout, /href="#contenido-principal"[\s\S]*?Saltar al contenido principal/);
  assert.match(appLayout, /<main id="contenido-principal" tabIndex=\{-1\}/);
});
