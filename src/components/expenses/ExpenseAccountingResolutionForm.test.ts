import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const formSource = readFileSync(
  fileURLToPath(new URL("./ExpenseAccountingResolutionForm.tsx", import.meta.url)),
  "utf8"
);
const pageSource = readFileSync(
  fileURLToPath(new URL("../../app/(expenses)/empresas/[companySlug]/rendiciones/contabilidad/page.tsx", import.meta.url)),
  "utf8"
);
const actionsSource = readFileSync(
  fileURLToPath(new URL("../../app/(expenses)/empresas/[companySlug]/rendiciones/actions.ts", import.meta.url)),
  "utf8"
);

test("una pausa elimina solo REQUEUE y conserva confirmar/cancelar", () => {
  assert.match(formSource, /\{requeueEnabled && <option value="REQUEUE">/);
  assert.match(formSource, /<option value="CONFIRM_SUCCEEDED">/);
  assert.match(formSource, /<option value="CANCEL">/);
  assert.match(pageSource, /requeueEnabled=\{accountingEnabled\}/);
});

test("la acción bloquea replay global y traduce la pausa tenant-aware", () => {
  assert.match(
    actionsSource,
    /resolution === "REQUEUE" && !readExpenseAccountingConfig\(\)\.enabled/
  );
  assert.match(actionsSource, /error\?\.code === "55000"/);
  assert.match(actionsSource, /Aún puedes confirmar o cancelar la salida/);
});
