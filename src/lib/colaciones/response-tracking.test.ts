import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMealReminderMessage, buildMealResponseTracking, mealReminderAvailableAt, type MealEligibleWorker } from "./response-tracking";

const WORKERS: MealEligibleWorker[] = [
  { employeeId: "1", firstName: "Juan", lastName: "Pérez", displayName: "Juan Pérez" },
  { employeeId: "2", firstName: "María", lastName: "González", displayName: "María González" },
  { employeeId: "3", firstName: "Pedro", lastName: "Soto", displayName: "Pedro Soto" },
];

test("detecta pendientes usando los empleados existentes y normaliza acentos", () => {
  const result = buildMealResponseTracking(WORKERS, ["  JUAN PEREZ ", "Pedro Soto"]);
  assert.equal(result.totalWorkers, 3);
  assert.equal(result.respondedCount, 2);
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(result.pendingWorkers.map((worker) => worker.displayName), ["María González"]);
});

test("una respuesta desconocida no reduce los pendientes y los nombres duplicados consumen una respuesta cada uno", () => {
  const duplicated = [...WORKERS, { ...WORKERS[0], employeeId: "4" }];
  const result = buildMealResponseTracking(duplicated, ["Juan Pérez", "Persona desconocida"]);
  assert.equal(result.respondedCount, 1);
  assert.equal(result.pendingCount, 3);
});

test("genera el recordatorio listo para copiar con los pendientes y el enlace real", () => {
  const tracking = buildMealResponseTracking(WORKERS, []);
  const message = buildMealReminderMessage(tracking.pendingWorkers, "https://forms.google.com/formulario");
  assert.match(message, /- Juan Pérez/);
  assert.match(message, /- María González/);
  assert.match(message, /https:\/\/forms\.google\.com\/formulario/);
});

test("calcula cuándo se habilita el recordatorio", () => {
  assert.equal(mealReminderAvailableAt("2026-08-20T12:00:00.000Z", 24)?.toISOString(), "2026-08-21T12:00:00.000Z");
});
