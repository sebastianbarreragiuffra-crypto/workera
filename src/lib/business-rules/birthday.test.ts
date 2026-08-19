import { test } from "node:test";
import assert from "node:assert/strict";
import { isBirthdayWeekdayAuthorizationApplicable, isAfterBirthdayAuthorizationThreshold } from "./birthday";

// 2026-08-17 = lunes, 2026-08-22 = sábado, 2026-08-23 = domingo (verificado).
const birthday = { birthMonth: 8, birthDay: 17 };

test("isBirthdayWeekdayAuthorizationApplicable: cumpleaños en día hábil -> true", () => {
  assert.equal(isBirthdayWeekdayAuthorizationApplicable(birthday, "2026-08-17"), true);
});

test("isBirthdayWeekdayAuthorizationApplicable: no es el cumpleaños -> false", () => {
  assert.equal(isBirthdayWeekdayAuthorizationApplicable(birthday, "2026-08-18"), false);
});

test("isBirthdayWeekdayAuthorizationApplicable: cumpleaños cae sábado -> false (PASO 30, sin traslado automático)", () => {
  const saturdayBirthday = { birthMonth: 8, birthDay: 22 };
  assert.equal(isBirthdayWeekdayAuthorizationApplicable(saturdayBirthday, "2026-08-22"), false);
});

test("isBirthdayWeekdayAuthorizationApplicable: cumpleaños cae domingo -> false", () => {
  const sundayBirthday = { birthMonth: 8, birthDay: 23 };
  assert.equal(isBirthdayWeekdayAuthorizationApplicable(sundayBirthday, "2026-08-23"), false);
});

test("isBirthdayWeekdayAuthorizationApplicable: nunca traslada automáticamente a viernes/lunes adyacente", () => {
  const saturdayBirthday = { birthMonth: 8, birthDay: 22 };
  // El viernes anterior (21) y el lunes siguiente (24) NO deben activar la autorización.
  assert.equal(isBirthdayWeekdayAuthorizationApplicable(saturdayBirthday, "2026-08-21"), false);
  assert.equal(isBirthdayWeekdayAuthorizationApplicable(saturdayBirthday, "2026-08-24"), false);
});

test("isAfterBirthdayAuthorizationThreshold: 11:59 -> false, 12:00 -> true, 12:01 -> true (PASO 56)", () => {
  assert.equal(isAfterBirthdayAuthorizationThreshold("11:59:00"), false);
  assert.equal(isAfterBirthdayAuthorizationThreshold("12:00:00"), true);
  assert.equal(isAfterBirthdayAuthorizationThreshold("12:01:00"), true);
});
