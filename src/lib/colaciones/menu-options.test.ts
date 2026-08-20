import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMealMenuParagraphs } from "./menu-docx";
import { buildMealFormOptions } from "./menu-options";

test("reconoce Agregado con y sin dos puntos", () => {
  const menu = parseMealMenuParagraphs([
    "MENÚ DE PRUEBA",
    "LUNES", "Menú: Pollo con ensalada / Churrasco", "Agregado arroz",
    "MARTES", "Menú: Lentejas",
    "MIÉRCOLES", "Menú: Pollo a la plancha", "Agregado: Puré",
    "JUEVES", "Menú: Cazuela",
    "VIERNES", "Menú: Sándwich",
  ]);

  assert.deepEqual(menu.days[0].accompaniments, ["arroz"]);
  assert.deepEqual(menu.days[2].accompaniments, ["Puré"]);
});

test("crea combinaciones para proteínas y conserva la opción original", () => {
  const options = buildMealFormOptions({
    day: "LUNES",
    menuOptions: ["Pollo con ensalada", "Churrasco"],
    accompaniments: ["Arroz"],
    extra: null,
  });

  assert.deepEqual(options, ["Pollo con ensalada", "Pollo con Arroz", "Churrasco", "Churrasco con Arroz"]);
});

test("incluye pollo con ensalada todos los días sin duplicarlo", () => {
  const menu = parseMealMenuParagraphs([
    "MENÚ SEMANAL",
    "LUNES", "Menú: Lentejas",
    "MARTES", "Menú: Pollo con ensalada / Cazuela",
    "MIÉRCOLES", "Menú: Pescado al horno",
    "JUEVES", "Menú: Charquicán",
    "VIERNES", "Menú: Churrasco", "Agregado: Arroz",
  ]);

  for (const day of menu.days) {
    const options = buildMealFormOptions(day);
    assert.equal(options.filter((option) => option.toLowerCase() === "pollo con ensalada").length, 1);
  }
});

test("omite del formulario el día marcado como feriado", () => {
  const menu = parseMealMenuParagraphs([
    "COLACIONES 11 AL 14 DE AGOSTO",
    "LUNES", "Menú: Espagueti a la boloñesa",
    "MARTES", "Menú: Lentejas",
    "MIÉRCOLES", "Menú: Pescado al horno",
    "JUEVES", "Menú: Churrasco", "Agregado: Arroz",
    "VIERNES 15 - FERIADO",
  ]);

  assert.deepEqual(menu.days.map((day) => day.day), ["LUNES", "MARTES", "MIERCOLES", "JUEVES"]);
  assert.deepEqual(menu.omittedDays, ["VIERNES"]);
});
