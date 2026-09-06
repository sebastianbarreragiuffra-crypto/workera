import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCOTEX_PILOT_ROSTER_SIZE, requireArcotexPilotEmployeeIds } from "./arcotex-pilot-roster";

const ids = Array.from({ length: ARCOTEX_PILOT_ROSTER_SIZE }, (_, index) =>
  `a7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

test("padrón piloto Arcotex: acepta exactamente 60 UUID únicos aprobados", () => {
  assert.deepEqual(requireArcotexPilotEmployeeIds(ids.join(",")), ids);
});

test("padrón piloto Arcotex: sin configuración bloquea la exportación en vez de incluir el padrón heredado", () => {
  assert.throws(() => requireArcotexPilotEmployeeIds(undefined), /permanece bloqueada/);
  assert.throws(() => requireArcotexPilotEmployeeIds("   "), /permanece bloqueada/);
});

test("padrón piloto Arcotex: falla cerrado ante faltantes, duplicados o IDs inválidos", () => {
  assert.throws(() => requireArcotexPilotEmployeeIds(ids.slice(0, 59).join(",")), /exactamente 60/);
  assert.throws(() => requireArcotexPilotEmployeeIds([...ids.slice(0, 59), ids[0]].join(",")), /exactamente 60/);
  assert.throws(() => requireArcotexPilotEmployeeIds([...ids.slice(0, 59), "no-es-uuid"].join(",")), /identificador inválido/);
});
