import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWorkeraEmployee } from "./employee";
import type { EmployeeGroupMappingTable } from "../types/employee-group";

const GROUP_MAPPING: EmployeeGroupMappingTable = { TEST_PRODUCTION: "PRODUCTION" };

test("payload válido y completo se mapea correctamente", () => {
  const result = mapWorkeraEmployee(
    { id: "E-1", rut: "11111111-1", first_name: "Ana", last_name: "Test", active: true, group: "TEST_PRODUCTION" },
    { groupMapping: GROUP_MAPPING }
  );
  assert.equal(result.externalId, "E-1");
  assert.equal(result.rut, "11111111-1");
  assert.equal(result.displayName, "Ana Test");
  assert.equal(result.active, true);
  assert.deepEqual(result.employeeGroup, { status: "MAPPED", group: "PRODUCTION" });
});

test("campos opcionales ausentes: displayName recurre al id, active por defecto true", () => {
  const result = mapWorkeraEmployee({ id: "E-2" }, { groupMapping: GROUP_MAPPING });
  assert.equal(result.firstName, null);
  assert.equal(result.lastName, null);
  assert.equal(result.displayName, "E-2");
  assert.equal(result.active, true);
  assert.equal(result.rut, null);
});

test("full_name presente tiene prioridad sobre first_name+last_name", () => {
  const result = mapWorkeraEmployee(
    { id: "E-3", first_name: "Ana", last_name: "Test", full_name: "Ana T. Completo" },
    { groupMapping: GROUP_MAPPING }
  );
  assert.equal(result.displayName, "Ana T. Completo");
});

test("grupo externo desconocido produce UNMAPPED, nunca una asignación por defecto", () => {
  const result = mapWorkeraEmployee(
    { id: "E-4", group: "GRUPO_QUE_NO_EXISTE" },
    { groupMapping: GROUP_MAPPING }
  );
  assert.deepEqual(result.employeeGroup, { status: "UNMAPPED", externalGroup: "GRUPO_QUE_NO_EXISTE" });
  assert.equal(result.externalGroup, "GRUPO_QUE_NO_EXISTE");
});

test("grupo externo ausente produce UNMAPPED con externalGroup null", () => {
  const result = mapWorkeraEmployee({ id: "E-5" }, { groupMapping: GROUP_MAPPING });
  assert.deepEqual(result.employeeGroup, { status: "UNMAPPED", externalGroup: null });
});
