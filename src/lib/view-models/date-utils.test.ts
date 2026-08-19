import { test } from "node:test";
import assert from "node:assert/strict";
import { todayInSantiago, previousDate, nextDate, formatDateLong } from "./date-utils";

test("todayInSantiago: devuelve la fecha calendario correcta para un instante conocido en Santiago", () => {
  // 2026-08-19 07:00 UTC == 2026-08-19 03:00 America/Santiago (invierno, UTC-4) -- mismo día calendario.
  assert.equal(todayInSantiago(new Date("2026-08-19T07:00:00Z")), "2026-08-19");
  // 2026-08-19 02:00 UTC == 2026-08-18 22:00 America/Santiago -- día calendario ANTERIOR.
  assert.equal(todayInSantiago(new Date("2026-08-19T02:00:00Z")), "2026-08-18");
});

test("previousDate / nextDate: aritmética de día calendario simple", () => {
  assert.equal(previousDate("2026-08-19"), "2026-08-18");
  assert.equal(nextDate("2026-08-19"), "2026-08-20");
});

test("previousDate / nextDate: cruzan límite de mes correctamente", () => {
  assert.equal(previousDate("2026-09-01"), "2026-08-31");
  assert.equal(nextDate("2026-08-31"), "2026-09-01");
});

test("formatDateLong: formatea en español sin desplazar el día", () => {
  const formatted = formatDateLong("2026-08-19");
  assert.match(formatted, /19/);
  assert.match(formatted, /agosto/);
});
