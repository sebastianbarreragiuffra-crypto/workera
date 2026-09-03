import { test } from "node:test";
import assert from "node:assert/strict";
import { requireYearMonth } from "./route";

/**
 * `mes` llega por query string y los resolvers de período hacen aritmética
 * directa sobre sus dos mitades sin validar nada: un mes fuera de rango se
 * convertía en una fecha imposible ("2026-00-01") que solo reventaba dentro de
 * la consulta, o en un mes distinto del pedido, sin aviso.
 */

test("requireYearMonth: acepta los doce meses reales", () => {
  for (const month of ["01", "02", "06", "09", "10", "11", "12"]) {
    assert.equal(requireYearMonth(`2026-${month}`), `2026-${month}`);
  }
});

test("requireYearMonth: rechaza el mes 00 -- generaba startDate '2026-00-01'", () => {
  assert.throws(() => requireYearMonth("2026-00"), /YYYY-MM/);
});

test("requireYearMonth: rechaza el mes 13 -- devolvía enero del año siguiente en silencio", () => {
  assert.throws(() => requireYearMonth("2026-13"), /YYYY-MM/);
  assert.throws(() => requireYearMonth("2026-99"), /YYYY-MM/);
});

test("requireYearMonth: rechaza ausencia, vacío y basura", () => {
  assert.throws(() => requireYearMonth(null), /Falta el parámetro/);
  assert.throws(() => requireYearMonth(""), /Falta el parámetro/);
  assert.throws(() => requireYearMonth("basura"), /YYYY-MM/);
});

test("requireYearMonth: rechaza formas casi correctas", () => {
  assert.throws(() => requireYearMonth("2026-9"), /YYYY-MM/, "sin cero a la izquierda");
  assert.throws(() => requireYearMonth("26-09"), /YYYY-MM/, "año de dos dígitos");
  assert.throws(() => requireYearMonth("2026-09-01"), /YYYY-MM/, "con día");
  assert.throws(() => requireYearMonth(" 2026-09"), /YYYY-MM/, "con espacio");
});
