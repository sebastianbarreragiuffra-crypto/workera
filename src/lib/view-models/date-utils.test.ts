import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDateLong,
  formatDateTimeInSantiago,
  formatCalendarDate,
  formatInstantInSantiago,
  formatTimeInSantiago,
  nextDate,
  previousDate,
  todayInSantiago,
} from "./date-utils";

test("formatTimeInSantiago: muestra la hora chilena aunque el servidor use UTC", () => {
  // Invierno: Santiago está en UTC-4.
  assert.equal(formatTimeInSantiago("2026-08-17T12:12:00Z"), "08:12");
  // Verano: Santiago está en UTC-3; Intl aplica DST automáticamente.
  assert.equal(formatTimeInSantiago("2026-01-15T12:12:00Z"), "09:12");
});

test("formatDateTimeInSantiago: puede cruzar correctamente al día anterior", () => {
  const formatted = formatDateTimeInSantiago("2026-08-19T02:30:00Z");
  assert.match(formatted, /18/);
  assert.match(formatted, /22:30/);
});

test("formatInstantInSantiago: no permite que options reemplace America/Santiago", () => {
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" } as Intl.DateTimeFormatOptions;
  assert.equal(formatInstantInSantiago("2026-08-17T12:12:00Z", options), "08:12");
});

test("formatInstantInSantiago: rechaza valores inválidos", () => {
  assert.throws(() => formatTimeInSantiago("no-es-una-fecha"), RangeError);
});

test("formatCalendarDate: conserva el día y rechaza rollovers inválidos", () => {
  assert.match(formatCalendarDate("2026-08-19"), /19/);
  assert.throws(() => formatCalendarDate("2026-02-31"), RangeError);
});

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
