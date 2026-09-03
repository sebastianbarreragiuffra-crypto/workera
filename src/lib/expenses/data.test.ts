import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpenseListFilters } from "./data";

/**
 * La query string la escribe cualquiera. Estos filtros terminan en un
 * `.range()` de PostgREST y en `santiagoDayStartIso`, que lanza ante un día
 * inexistente -- y las páginas de rendiciones no envuelven esas llamadas en
 * try/catch, así que todo lo que este parser deje pasar mal se convierte en un
 * 500 provocable desde la barra de direcciones.
 */

test("pagina: un valor normal se respeta", () => {
  assert.equal(parseExpenseListFilters({ pagina: "3" }).page, 3);
});

test("pagina: 0 y negativos caen a 1 -- producían el rango [-20,-1] que PostgREST rechaza", () => {
  assert.equal(parseExpenseListFilters({ pagina: "0" }).page, 1);
  assert.equal(parseExpenseListFilters({ pagina: "-5" }).page, 1);
});

test("pagina: basura, vacío y ausente caen a 1", () => {
  assert.equal(parseExpenseListFilters({ pagina: "abc" }).page, 1);
  assert.equal(parseExpenseListFilters({ pagina: "" }).page, 1);
  assert.equal(parseExpenseListFilters({}).page, 1);
});

test("pagina: un entero fuera del rango seguro cae a 1, nunca a un offset absurdo", () => {
  assert.equal(parseExpenseListFilters({ pagina: "99999999999999999999" }).page, 1);
});

test("estado: solo se acepta un estado real del enum", () => {
  assert.equal(parseExpenseListFilters({ estado: "APPROVED" }).status, "APPROVED");
  assert.equal(parseExpenseListFilters({ estado: "approved" }).status, null);
  assert.equal(parseExpenseListFilters({ estado: "DROP TABLE" }).status, null);
});

test("desde/hasta: una fecha real se conserva", () => {
  const filters = parseExpenseListFilters({ desde: "2026-09-01", hasta: "2026-09-30" });
  assert.equal(filters.from, "2026-09-01");
  assert.equal(filters.to, "2026-09-30");
});

test("desde/hasta: una fecha con formato válido pero inexistente se descarta", () => {
  // Cumplen la regex YYYY-MM-DD y no existen: antes llegaban a
  // santiagoDayStartIso y tiraban la página.
  assert.equal(parseExpenseListFilters({ desde: "2026-13-45" }).from, null);
  assert.equal(parseExpenseListFilters({ desde: "2026-02-30" }).from, null);
  assert.equal(parseExpenseListFilters({ hasta: "2025-02-29" }).to, null);
});

test("desde/hasta: formato incorrecto o basura se descarta", () => {
  assert.equal(parseExpenseListFilters({ desde: "2026-9-1" }).from, null, "sin ceros a la izquierda");
  assert.equal(parseExpenseListFilters({ desde: "01-09-2026" }).from, null);
  assert.equal(parseExpenseListFilters({ desde: "ayer" }).from, null);
});

test("desde/hasta: un rango invertido descarta el extremo final, no ambos", () => {
  const filters = parseExpenseListFilters({ desde: "2026-09-30", hasta: "2026-09-01" });
  assert.equal(filters.from, "2026-09-30");
  assert.equal(filters.to, null);
});
