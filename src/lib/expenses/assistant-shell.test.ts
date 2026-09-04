import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(
  path.join(process.cwd(), "src", "components", "expenses", "ExpenseShell.tsx"),
  "utf8"
);

test("el enlace del asistente usa el mismo gate de lectura agregada que el servicio", () => {
  assert.match(
    source,
    /\(context\.canReadAll \|\| context\.canApprove \|\| context\.canReconcile \|\| context\.canManage\) && \(\s*<Link href=\{`\$\{base\}\/asistente`\}/
  );
});

test("el asistente no se muestra por permisos de envío o configuración solamente", () => {
  const assistantLink = source.indexOf("${base}/asistente");
  assert.ok(assistantLink >= 0);
  const gateStart = source.lastIndexOf("{(", assistantLink);
  const gate = source.slice(gateStart, assistantLink);
  assert.doesNotMatch(gate, /canSubmit|canConfigure/);
});
