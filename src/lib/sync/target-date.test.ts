import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetDate, resolveReconciliationWindow } from "./target-date";

test("resolveTargetDate: día calendario anterior en horario normal (invierno chileno, UTC-4)", () => {
  // 2026-08-20T10:00:00Z = 2026-08-20 06:00 America/Santiago (UTC-4) -> D-1 = 2026-08-19.
  assert.equal(resolveTargetDate(new Date("2026-08-20T10:00:00Z")), "2026-08-19");
});

test("resolveTargetDate: cerca de medianoche local, sigue siendo el día calendario correcto", () => {
  // 2026-08-20T03:59:00Z = 2026-08-19 23:59 America/Santiago -> D-1 de "hoy" (19) es 18.
  assert.equal(resolveTargetDate(new Date("2026-08-20T03:59:00Z")), "2026-08-18");
  // Un minuto después cruza a 2026-08-20 00:00 local -> D-1 pasa a ser 19.
  assert.equal(resolveTargetDate(new Date("2026-08-20T04:01:00Z")), "2026-08-19");
});

test("resolveTargetDate: cruce de fin de año", () => {
  assert.equal(resolveTargetDate(new Date("2027-01-01T10:00:00Z")), "2026-12-31");
});

test("resolveTargetDate: cruce de fin de mes/año bisiesto (Marzo 1 -> Feb 28/29)", () => {
  assert.equal(resolveTargetDate(new Date("2027-03-01T10:00:00Z")), "2027-02-28");
  assert.equal(resolveTargetDate(new Date("2028-03-01T10:00:00Z")), "2028-02-29"); // 2028 es bisiesto.
});

test("resolveTargetDate: día siguiente a un cambio de horario de verano (Fase 6B, PASO 38) -- calendario, no menos-24h", () => {
  // No se asume una fecha exacta de transición DST -- lo que se prueba es
  // que el resultado sea SIEMPRE el día calendario anterior, sin importar
  // si ese día real tuvo 23, 24 o 25 horas. Restar 24h de una hora de pared
  // real en un día de 23h aterrizaría un día antes de lo debido; esta
  // implementación nunca hace esa resta.
  const aroundSeptemberTransition = resolveTargetDate(new Date("2026-09-07T13:00:00Z"));
  assert.equal(aroundSeptemberTransition, "2026-09-06");

  const aroundAprilTransition = resolveTargetDate(new Date("2026-04-05T13:00:00Z"));
  assert.equal(aroundAprilTransition, "2026-04-04");
});

test("resolveTargetDate: acepta una zona horaria explícita distinta (no hardcodea America/Santiago)", () => {
  // UTC: "ayer" en UTC es trivialmente la fecha UTC menos un día.
  assert.equal(resolveTargetDate(new Date("2026-08-20T10:00:00Z"), "UTC"), "2026-08-19");
});

test("resolveReconciliationWindow: 0 días adicionales -> solo la fecha objetivo", () => {
  assert.deepEqual(resolveReconciliationWindow("2026-08-19", 0), ["2026-08-19"]);
});

test("resolveReconciliationWindow: N días adicionales, ordenado de más antiguo a más reciente, termina en targetDate", () => {
  assert.deepEqual(resolveReconciliationWindow("2026-08-19", 2), ["2026-08-17", "2026-08-18", "2026-08-19"]);
});

test("resolveReconciliationWindow: cruza límite de mes correctamente", () => {
  assert.deepEqual(resolveReconciliationWindow("2026-09-01", 2), ["2026-08-30", "2026-08-31", "2026-09-01"]);
});

test("resolveReconciliationWindow: reconciliationDays negativo lanza error explícito (nunca una ventana silenciosamente vacía)", () => {
  assert.throws(() => resolveReconciliationWindow("2026-08-19", -1), /reconciliationDays/);
});
