import { test } from "node:test";
import assert from "node:assert/strict";
import { santiagoWallClockMinutesSinceMidnight, scheduledTimeToMinutes, santiagoWallClockToInstant } from "./wall-clock";

test("santiagoWallClockMinutesSinceMidnight: convierte un instante UTC a minutos de hora de pared Santiago (invierno, UTC-4)", () => {
  // 2026-08-17T11:29:00Z = 07:29 America/Santiago (invierno chileno).
  assert.equal(santiagoWallClockMinutesSinceMidnight(new Date("2026-08-17T11:29:00.000Z")), 7 * 60 + 29);
});

test("santiagoWallClockMinutesSinceMidnight: medianoche exacta -> 0, nunca '24:00'", () => {
  // 2026-08-17T04:00:00Z = 00:00 America/Santiago.
  assert.equal(santiagoWallClockMinutesSinceMidnight(new Date("2026-08-17T04:00:00.000Z")), 0);
});

test("scheduledTimeToMinutes: convierte HH:MM:SS a minutos desde medianoche", () => {
  assert.equal(scheduledTimeToMinutes("07:30:00"), 7 * 60 + 30);
  assert.equal(scheduledTimeToMinutes("00:00:00"), 0);
  assert.equal(scheduledTimeToMinutes("23:59:00"), 23 * 60 + 59);
});

// ---------------------------------------------------------------------------
// santiagoWallClockToInstant (MB-3)

test("santiagoWallClockToInstant: invierte exactamente a santiagoWallClockMinutesSinceMidnight", () => {
  // La propiedad que realmente importa: lo que el jefe escribe es lo que el
  // motor lee de vuelta como hora de pared, sin importar el offset del día.
  for (const date of ["2026-01-15", "2026-06-15", "2026-09-01", "2026-12-20"]) {
    for (const wall of ["07:30", "12:00", "17:00", "23:59"]) {
      const instant = santiagoWallClockToInstant(date, wall);
      const [h, m] = wall.split(":").map(Number);
      assert.equal(
        santiagoWallClockMinutesSinceMidnight(instant),
        h * 60 + m,
        `${date} ${wall} no sobrevivió el viaje de ida y vuelta`
      );
    }
  }
});

test("santiagoWallClockToInstant: invierno chileno (UTC-4) -- 17:30 de pared es 21:30 UTC", () => {
  // Junio = horario de invierno en Chile.
  assert.equal(santiagoWallClockToInstant("2026-06-15", "17:30").toISOString(), "2026-06-15T21:30:00.000Z");
});

test("santiagoWallClockToInstant: verano chileno (UTC-3) -- 17:30 de pared es 20:30 UTC", () => {
  // Enero = horario de verano en Chile. Un offset hardcodeado fallaría acá.
  assert.equal(santiagoWallClockToInstant("2026-01-15", "17:30").toISOString(), "2026-01-15T20:30:00.000Z");
});

test("santiagoWallClockToInstant: nunca interpreta la hora en la zona del servidor", () => {
  // Si la función usara `new Date("2026-06-15T17:30")` (hora local del
  // proceso), en un servidor UTC daría 17:30Z -- 4 horas corridas.
  const instant = santiagoWallClockToInstant("2026-06-15", "17:30");
  assert.notEqual(instant.toISOString(), "2026-06-15T17:30:00.000Z");
});

test("santiagoWallClockToInstant: la fecha calendario de Santiago se conserva", () => {
  // Una salida tarde no debe caer en el día siguiente al convertir.
  const instant = santiagoWallClockToInstant("2026-09-01", "23:00");
  const santiagoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  assert.equal(santiagoDate, "2026-09-01");
});
