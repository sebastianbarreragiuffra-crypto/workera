import { test } from "node:test";
import assert from "node:assert/strict";
import { santiagoWallClockMinutesSinceMidnight, scheduledTimeToMinutes } from "./wall-clock";

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
