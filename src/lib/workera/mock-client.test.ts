import { test } from "node:test";
import assert from "node:assert/strict";
import { MockWorkeraClient } from "./mock-client";

const WEEKDAY = { from: "2026-08-10", to: "2026-08-10" };
const SATURDAY = { from: "2026-08-15", to: "2026-08-15" };
const FULL_RANGE = { from: "2026-01-01", to: "2026-12-31" };

test("getEmployees devuelve trabajadores ficticios, ninguno real", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getEmployees();

  assert.ok(items.length > 0);
  for (const employee of items) {
    assert.match(employee.displayName, /Demo|Desconocido/);
  }
});

test("escenario normal: clock_in 07:28, clock_out 17:00", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: WEEKDAY });
  const sebastian = items.find((a) => a.employeeExternalId === "MOCK-001" && a.externalRecordId === "ATT-001");

  assert.ok(sebastian);
  assert.equal(sebastian.clockIn?.raw, "2026-08-10T07:28:00-04:00");
  assert.equal(sebastian.clockOut?.raw, "2026-08-10T17:00:00-04:00");
});

test("escenario atraso: clock_in 07:43", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: WEEKDAY });
  const juan = items.find((a) => a.employeeExternalId === "MOCK-002" && a.externalRecordId === "ATT-002");

  assert.equal(juan?.clockIn?.raw, "2026-08-10T07:43:00-04:00");
});

test("escenario candidato a horas extra: clock_out 18:00", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: WEEKDAY });
  const maria = items.find((a) => a.employeeExternalId === "MOCK-003");

  assert.equal(maria?.clockOut?.raw, "2026-08-10T18:00:00-04:00");
});

test("escenario horas extra al tope: clock_out 19:45", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: WEEKDAY });
  const pedro = items.find((a) => a.employeeExternalId === "MOCK-004");

  assert.equal(pedro?.clockOut?.raw, "2026-08-10T19:45:00-04:00");
});

test("escenario marcación faltante: clock_out null, nunca inventado", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: WEEKDAY });
  const andrea = items.find((a) => a.employeeExternalId === "MOCK-005");

  assert.ok(andrea);
  assert.equal(andrea.clockOut, null);
  assert.notEqual(andrea.clockIn, null);
});

test("escenario Instalación fin de semana: registro en sábado", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: SATURDAY });
  const ignacio = items.find((a) => a.employeeExternalId === "MOCK-009");

  assert.ok(ignacio);
  assert.equal(ignacio.workDate, "2026-08-15");

  const { items: employees } = await client.getEmployees();
  const ignacioEmployee = employees.find((e) => e.externalId === "MOCK-009");
  assert.deepEqual(ignacioEmployee?.employeeGroup, { status: "MAPPED", group: "INSTALLATION" });
});

test("filtrado por rango de fechas: fuera de rango no aparece", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: SATURDAY });

  assert.equal(items.some((a) => a.employeeExternalId === "MOCK-001"), false);
});

test("escenario vacaciones", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAbsences({ range: FULL_RANGE });
  const carla = items.find((a) => a.employeeExternalId === "MOCK-006");

  assert.equal(carla?.type, "VACATION");
});

test("escenario licencia médica", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAbsences({ range: FULL_RANGE });
  const diego = items.find((a) => a.employeeExternalId === "MOCK-007");

  assert.equal(diego?.type, "MEDICAL_LEAVE");
});

test("escenario mutual", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAbsences({ range: FULL_RANGE });
  const fernanda = items.find((a) => a.employeeExternalId === "MOCK-008");

  assert.equal(fernanda?.type, "MUTUAL");
});

test("grupo externo no mapeado se representa como UNMAPPED, no como una asignación al azar", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getEmployees();
  const fantasma = items.find((e) => e.externalId === "MOCK-011");

  assert.deepEqual(fantasma?.employeeGroup, { status: "UNMAPPED", externalGroup: "MOCK_GRUPO_FANTASMA" });
});

test("código de estado diario no reconocido produce UNKNOWN_EXTERNAL_STATUS", async () => {
  const client = new MockWorkeraClient();
  const { items } = await client.getAttendance({ range: WEEKDAY });
  const withStatus = items.find((a) => a.externalRecordId === "ATT-002-STATUS");

  assert.ok(withStatus);
});

test("los escenarios son reproducibles: dos llamadas devuelven los mismos datos", async () => {
  const client = new MockWorkeraClient();
  const first = await client.getEmployees();
  const second = await client.getEmployees();

  assert.deepEqual(first.items, second.items);
});
