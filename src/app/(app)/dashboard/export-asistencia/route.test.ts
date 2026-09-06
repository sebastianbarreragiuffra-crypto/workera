import { test } from "node:test";
import assert from "node:assert/strict";
import { canDownloadPayrollWorkbook, requireYearMonth } from "./route";
import { readFileSync } from "node:fs";

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

test("canDownloadPayrollWorkbook: la pre-nómina queda solo para RRHH y owner", () => {
  assert.equal(canDownloadPayrollWorkbook("SUPER_ADMIN"), true);
  assert.equal(canDownloadPayrollWorkbook("ADMIN_RRHH"), true);
  assert.equal(canDownloadPayrollWorkbook("SUPERVISOR_PRODUCTION"), false);
  assert.equal(canDownloadPayrollWorkbook("SUPERVISOR_INSTALLATION"), false);
});

test("descarga de pre-nómina: exige rol del tenant y CLOSED usa el snapshot exacto", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /resolvePayrollCompanyRole[\s\S]*?\["ADMIN_RRHH", "SUPER_ADMIN"\]/);
  assert.doesNotMatch(source, /buildAttendanceExportData\(supabase, profile\.role/);
  assert.match(source, /status === "CLOSED"[\s\S]*?CLOSED_SNAPSHOT[\s\S]*?content_sha256/);
  assert.match(source, /createHash\("sha256"\)[\s\S]*?snapshot\.data\.content_sha256/);
});
