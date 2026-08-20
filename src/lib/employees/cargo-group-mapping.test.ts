import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCargoToGroup, UNMAPPED_CARGO_VALUES } from "./cargo-group-mapping";

test("mapCargoToGroup: los 9 valores reales del archivo mapean como se documentó (o quedan sin asignar)", () => {
  assert.equal(mapCargoToGroup("OPERARIO DE PRODUCCION"), "PRODUCTION");
  assert.equal(mapCargoToGroup("SUPERVISOR DE PRODUCCION"), "PRODUCTION");
  assert.equal(mapCargoToGroup("INSTALACION"), "INSTALLATION");
  assert.equal(mapCargoToGroup("SUPERVISOR DE INSTALACION"), "INSTALLATION");
  assert.equal(mapCargoToGroup("ADMINISTRATIVO"), "ADMINISTRATION");
  assert.equal(mapCargoToGroup("SUPERVISOR DE ADMINISTRACION"), "ADMINISTRATION");
  assert.equal(mapCargoToGroup("GERENTE GENERAL"), "ADMINISTRATION");
  assert.equal(mapCargoToGroup("AUXILIAR DE ASEO"), null, "sin palabra clave de área -- nunca se adivina");
  assert.equal(mapCargoToGroup("PREVENCIONISTA DE RIESGOS"), null, "sin palabra clave de área -- nunca se adivina");
});

test("mapCargoToGroup: cargo desconocido/no catalogado -> null (SIN_ASIGNAR), nunca se inventa una categoría", () => {
  assert.equal(mapCargoToGroup("ALGO_TOTALMENTE_NUEVO"), null);
  assert.equal(mapCargoToGroup(""), null);
});

test("mapCargoToGroup: ignora mayúsculas/minúsculas y espacios extra", () => {
  assert.equal(mapCargoToGroup("  operario de produccion  "), "PRODUCTION");
  assert.equal(mapCargoToGroup("Operario De Produccion"), "PRODUCTION");
});

test("UNMAPPED_CARGO_VALUES documenta explícitamente los cargos ambiguos (no es un olvido)", () => {
  assert.deepEqual(UNMAPPED_CARGO_VALUES, ["AUXILIAR DE ASEO", "PREVENCIONISTA DE RIESGOS"]);
  for (const cargo of UNMAPPED_CARGO_VALUES) {
    assert.equal(mapCargoToGroup(cargo), null);
  }
});
