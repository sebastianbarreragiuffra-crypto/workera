import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const filterBar = readFileSync(new URL("./FilterBar.tsx", import.meta.url), "utf8");

test("FilterBar conserva estructura navegable semántica", () => {
  assert.match(filterBar, /<nav aria-label="Filtros">/);
  assert.match(filterBar, /<ul className="flex flex-wrap gap-2">/);
  assert.match(filterBar, /<li key={option.key}>/);
});

test("FilterBar usa aria-current=\"page\" cuando la opción está activa", () => {
  assert.match(filterBar, /aria-current={option.active \? "page" : undefined}/);
});

test("FilterBar mantiene un único texto sr-only para conteo y no usa aria-label redundante en Link", () => {
  const srOnlyCount = filterBar.match(/<span className="sr-only">/g)?.length ?? 0;
  assert.equal(srOnlyCount, 1);
  assert.doesNotMatch(filterBar, /aria-label=\{/);
});

test("FilterBar anuncia el conteo con singular/plural en sr-only", () => {
  assert.match(filterBar, /{option.count === 1 \? " \(1 resultado\)" : ` \(\$\{option.count\} resultados\)`}/);
  assert.match(filterBar, /<span className="ml-1 opacity-80" aria-hidden="true">/);
  assert.match(filterBar, /<span className="sr-only">\s*{option.count === 1 \? " \(1 resultado\)" : ` \(\$\{option.count\} resultados\)`}\s*<\/span>/);
});
