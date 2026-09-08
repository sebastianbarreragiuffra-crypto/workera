import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboardPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("dashboard agrega foco visible consistente en enlaces de periodo", () => {
  assert.match(
    dashboardPage,
    /className={`rounded-md border px-3 py-1\.5 text-sm \$\{[\s\S]*focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue[\s\S]*\}`}/,
  );
  assert.match(
    dashboardPage,
    /className=\"rounded-md border border-slate-300 px-3 py-1\.5 text-sm text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue\"/,
  );
});

test("dashboard agrega foco visible en selector de fecha manual", () => {
  assert.match(dashboardPage, /dashboard-date\"[\s\S]*focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2/);
  assert.match(
    dashboardPage,
    /type=\"submit\"[\s\S]*focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue/,
  );
});
