import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const loadingSource = readFileSync(new URL("./loading.tsx", import.meta.url), "utf8");

test("la carga de revisión diaria anuncia su estado sin exponer el esqueleto", () => {
  assert.match(loadingSource, /role="status" aria-label="Cargando revisión diaria"/);
  assert.match(loadingSource, /className="animate-pulse space-y-4" aria-hidden="true"/);
});
