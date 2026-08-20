import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWeeklyMealGoogleFormPayload } from "./google-forms-payload";
import { parseMealMenuParagraphs } from "./menu-docx";

test("crea preguntas solo para días laborables y agrega las opciones fijas", () => {
  const menu = parseMealMenuParagraphs([
    "COLACIONES 11 AL 14 DE AGOSTO",
    "LUNES", "Menú: Lentejas",
    "MARTES", "Menú: Pollo a la plancha", "Agregado: Arroz",
    "MIÉRCOLES", "Menú: Pescado",
    "JUEVES", "Menú: Churrasco",
    "VIERNES - FERIADO",
  ]);

  const payload = buildWeeklyMealGoogleFormPayload({
    menu,
    requestId: "menu-123",
    closeDate: "2026-08-06",
    closeTime: "13:00",
    reminderAfterHours: 24,
    employeeNames: ["María González", "Juan Pérez", "María González"],
  });

  assert.deepEqual(payload.questions.map((question) => question.title), ["LUNES", "MARTES", "MIERCOLES", "JUEVES"]);
  assert.deepEqual(payload.questions[0].options, ["Pollo con ensalada", "Lentejas", "No vengo a trabajar"]);
  assert.deepEqual(payload.questions[1].options, ["Pollo con ensalada", "Pollo a la plancha", "Pollo a la plancha con Arroz", "No vengo a trabajar"]);
  assert.equal(payload.closeAtLocal, "2026-08-06T13:00:00");
  assert.equal(payload.reminderAfterHours, 24);
  assert.deepEqual(payload.employeeNames, ["Juan Pérez", "María González"]);
  assert.deepEqual(payload.omittedDays, ["VIERNES"]);
});
