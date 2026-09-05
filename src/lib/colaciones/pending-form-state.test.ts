import assert from "node:assert/strict";
import test from "node:test";
import { openPendingMealFormState, PendingMealFormStateError, sealPendingMealFormState } from "./pending-form-state";
import type { PendingMealFormState } from "./pending-form-state";

const SECRET = "test-secret-that-is-at-least-thirty-two-characters-long";
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

const fixture: PendingMealFormState = {
  fileName: "menu-semana.docx",
  menu: {
    title: "Menú semanal",
    days: [{
      day: "LUNES",
      menuOptions: ["Pollo con arroz"],
      accompaniments: ["Ensalada"],
      extra: null,
    }],
    omittedDays: ["VIERNES"],
  },
  payload: {
    requestId: "a".repeat(64),
    title: "Menú semanal",
    description: "El formulario se cierra el viernes.",
    closeAtLocal: "2026-09-11T13:00:00",
    reminderAfterHours: 24,
    employeeNames: ["Ana Pérez", "Juan Soto"],
    omittedDays: ["VIERNES"],
    questions: [{ title: "LUNES", options: ["Pollo con arroz", "No vengo a trabajar"] }],
  },
};

test("sella y recupera exactamente el estado pendiente dentro de su vigencia", () => {
  const token = sealPendingMealFormState(fixture, { secret: SECRET, nowMs: NOW });
  assert.deepEqual(openPendingMealFormState(token, { secret: SECRET, nowMs: NOW + 1 }), fixture);
  assert.ok(!token.includes("Ana"), "la nómina no debe quedar visible en el HTML");
  assert.ok(!token.includes("Pollo"), "el menú no debe quedar visible en el HTML");
});

test("usa nonce aleatorio: el mismo estado no produce tokens correlacionables", () => {
  const first = sealPendingMealFormState(fixture, { secret: SECRET, nowMs: NOW });
  const second = sealPendingMealFormState(fixture, { secret: SECRET, nowMs: NOW });
  assert.notEqual(first, second);
});

test("rechaza cualquier manipulación, secreto distinto o token malformado", () => {
  const token = sealPendingMealFormState(fixture, { secret: SECRET, nowMs: NOW });
  const index = Math.floor(token.length / 2);
  const replacement = token[index] === "A" ? "B" : "A";
  const tampered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;

  for (const candidate of [tampered, "v1.invalid", "", `v2.${token.slice(3)}`]) {
    assert.throws(
      () => openPendingMealFormState(candidate, { secret: SECRET, nowMs: NOW }),
      PendingMealFormStateError,
    );
  }
  assert.throws(
    () => openPendingMealFormState(token, { secret: `${SECRET}-different`, nowMs: NOW }),
    PendingMealFormStateError,
  );
});

test("vence a los 30 minutos y nunca acepta una vigencia mayor", () => {
  const token = sealPendingMealFormState(fixture, { secret: SECRET, nowMs: NOW });
  assert.doesNotThrow(() => openPendingMealFormState(token, { secret: SECRET, nowMs: NOW + 30 * 60 * 1000 - 1 }));
  assert.throws(
    () => openPendingMealFormState(token, { secret: SECRET, nowMs: NOW + 30 * 60 * 1000 }),
    PendingMealFormStateError,
  );
  assert.throws(
    () => sealPendingMealFormState(fixture, { secret: SECRET, nowMs: NOW, ttlMs: 30 * 60 * 1000 + 1 }),
    PendingMealFormStateError,
  );
});

test("rechaza secretos débiles, formas agregadas y cargas excesivas antes de sellar", () => {
  assert.throws(() => sealPendingMealFormState(fixture, { secret: "short", nowMs: NOW }), PendingMealFormStateError);

  const extraField = structuredClone(fixture) as PendingMealFormState & { admin?: boolean };
  extraField.admin = true;
  assert.throws(() => sealPendingMealFormState(extraField, { secret: SECRET, nowMs: NOW }), PendingMealFormStateError);

  const oversized = structuredClone(fixture);
  oversized.payload.employeeNames = Array.from({ length: 500 }, (_, index) => `${index}-${"x".repeat(159)}`);
  assert.throws(() => sealPendingMealFormState(oversized, { secret: SECRET, nowMs: NOW }), PendingMealFormStateError);
});
