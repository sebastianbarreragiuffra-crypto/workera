import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(
  path.join(process.cwd(), "src", "components", "pwa", "PwaLifecycle.tsx"),
  "utf8"
);

test("el service worker se registra solo en producción", () => {
  assert.match(source, /process\.env\.NODE_ENV === "production"/);
  assert.match(source, /serviceWorker\.register\("\/sw\.js"/);
});

test("desarrollo elimina únicamente el worker y caches de GESTORA que hayan sobrevivido", () => {
  assert.match(source, /getRegistrations\(\)/);
  assert.match(source, /new URL\(worker\.scriptURL\)\.pathname === "\/sw\.js"/);
  assert.match(source, /key\.startsWith\("gestora-shell-"\)/);
  assert.doesNotMatch(source, /registrations\.map\(\(registration\) => registration\.unregister\(\)\)/);
});
