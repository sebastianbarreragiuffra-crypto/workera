import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sidebarSource = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

test("el sidebar conserva el nombre accesible completo cuando solo muestra la inicial", () => {
  assert.match(
    sidebarSource,
    /key=\{item\.href\}[\s\S]*?href=\{item\.href\}[\s\S]*?aria-label=\{item\.label\}[\s\S]*?aria-current=/,
  );
});
