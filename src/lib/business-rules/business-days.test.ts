import { test } from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, isBusinessDay } from "./business-days";

test("isBusinessDay: lunes-viernes true, sábado/domingo false", () => {
  assert.equal(isBusinessDay("2026-08-17"), true); // lunes
  assert.equal(isBusinessDay("2026-08-21"), true); // viernes
  assert.equal(isBusinessDay("2026-08-22"), false); // sábado
  assert.equal(isBusinessDay("2026-08-23"), false); // domingo
});

test("addBusinessDays: viernes + 3 días hábiles = miércoles (PASO 57 del encargo)", () => {
  // 2026-08-21 es viernes.
  assert.equal(addBusinessDays("2026-08-21", 3), "2026-08-26"); // miércoles
});

test("addBusinessDays: 0 días devuelve la misma fecha", () => {
  assert.equal(addBusinessDays("2026-08-17", 0), "2026-08-17");
});

test("addBusinessDays: desde un lunes, 1 día hábil = martes", () => {
  assert.equal(addBusinessDays("2026-08-17", 1), "2026-08-18");
});

test("addBusinessDays: desde un fin de semana también salta correctamente el fin de semana", () => {
  // 2026-08-22 es sábado -> +1 día hábil debe caer en lunes 2026-08-24.
  assert.equal(addBusinessDays("2026-08-22", 1), "2026-08-24");
});

test("addBusinessDays: cruza límite de mes", () => {
  // 2026-08-28 es viernes -> +3 días hábiles: lunes 31, martes 1, miércoles 2.
  assert.equal(addBusinessDays("2026-08-28", 3), "2026-09-02");
});

test("addBusinessDays: días negativos lanza error explícito", () => {
  assert.throws(() => addBusinessDays("2026-08-17", -1), /days/);
});

// --- MB-6: feriados legales ---

test("isBusinessDay: un feriado en el set no es día hábil aunque sea lunes-viernes", () => {
  const feriados = new Set(["2026-09-18"]); // Independencia (viernes)
  assert.equal(isBusinessDay("2026-09-18", feriados), false);
  assert.equal(isBusinessDay("2026-09-17", feriados), true); // jueves, no feriado
});

test("isBusinessDay: sin set de feriados el comportamiento es el histórico (solo fin de semana)", () => {
  assert.equal(isBusinessDay("2026-09-18"), true); // viernes, sin info de feriados
});

test("addBusinessDays: salta un feriado que cae entre medio", () => {
  // 2026-09-16 miércoles. +2 días hábiles sin feriados = viernes 18.
  assert.equal(addBusinessDays("2026-09-16", 2), "2026-09-18");
  // Con el 18 (Independencia) feriado: jueves 17 cuenta, viernes 18 y fin de
  // semana no, lunes 21 cuenta -> 2026-09-21.
  const feriados = new Set(["2026-09-18"]);
  assert.equal(addBusinessDays("2026-09-16", 2, feriados), "2026-09-21");
});

test("addBusinessDays: dos feriados seguidos empujan el plazo aún más", () => {
  // 2026-09-17 jueves, +1 día hábil. Viernes 18 feriado, fin de semana,
  // lunes 21 feriado (hipotético), martes 22 cuenta -> 2026-09-22.
  const feriados = new Set(["2026-09-18", "2026-09-21"]);
  assert.equal(addBusinessDays("2026-09-17", 1, feriados), "2026-09-22");
});
