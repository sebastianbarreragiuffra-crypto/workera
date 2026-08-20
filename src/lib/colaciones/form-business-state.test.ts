import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreatedWeeklyMealGoogleForm, WeeklyMealGoogleFormStatus } from "./google-forms";
import { getMealFormBusinessState } from "./form-business-state";

const FORM: CreatedWeeklyMealGoogleForm = {
  formId: "form-1",
  title: "Colaciones semanales",
  responderUrl: "https://example.com/responder",
  editUrl: "https://example.com/editar",
  responseSheetUrl: "https://example.com/respuestas",
  responseSheetDownloadUrl: "https://example.com/descargar",
  closeAtLocal: "2026-08-21T13:00:00.000Z",
  reminderAfterHours: 24,
  createdAt: "2026-08-20T10:00:00.000Z",
  dayLabels: ["LUNES"],
  omittedDays: [],
  reused: false,
};

const OPEN_STATUS: WeeklyMealGoogleFormStatus = {
  formId: FORM.formId,
  respondentNames: [],
  responseCount: 0,
  acceptingResponses: true,
  updatedAt: "2026-08-20T12:00:00.000Z",
};

test("muestra un formulario activo y estado abierto dentro del período permitido", () => {
  assert.deepEqual(
    getMealFormBusinessState(FORM, OPEN_STATUS, new Date("2026-08-20T12:00:00.000Z")),
    { activeFormCount: 1, responseStatus: "ABIERTO" },
  );
});

test("muestra cero formularios activos cuando no existe un formulario", () => {
  assert.deepEqual(
    getMealFormBusinessState(null, null, new Date("2026-08-20T12:00:00.000Z")),
    { activeFormCount: 0, responseStatus: "CERRADO" },
  );
});

test("muestra estado cerrado cuando Google Forms no acepta respuestas", () => {
  assert.deepEqual(
    getMealFormBusinessState(FORM, { ...OPEN_STATUS, acceptingResponses: false }, new Date("2026-08-20T12:00:00.000Z")),
    { activeFormCount: 0, responseStatus: "CERRADO" },
  );
});

test("muestra estado cerrado fuera del período aunque el formulario todavía acepte respuestas", () => {
  assert.deepEqual(
    getMealFormBusinessState(FORM, OPEN_STATUS, new Date("2026-08-22T12:00:00.000Z")),
    { activeFormCount: 0, responseStatus: "CERRADO" },
  );
});
