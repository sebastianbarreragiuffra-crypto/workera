import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const stateMessagesSource = readFileSync(new URL("./StateMessages.tsx", import.meta.url), "utf8");

test("el enlace de reintento no precarga la misma respuesta fallida", () => {
  assert.match(stateMessagesSource, /href=\{retryHref\}[\s\S]*?prefetch=\{false\}/);
});
