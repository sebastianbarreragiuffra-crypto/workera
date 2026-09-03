import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWorkeraAttendance, mapWorkeraAttendanceStatus } from "./attendance";
import { mapWorkeraAttendanceEvent } from "./attendance-event";
import type { AttendanceStatusMappingTable } from "../types/attendance-status";

test("clock_in y clock_out presentes se normalizan a instantes UTC", () => {
  const result = mapWorkeraAttendance({
    employee_id: "E-1",
    date: "2026-08-10",
    clock_in: "2026-08-10T07:30:00-04:00",
    clock_out: "2026-08-10T17:00:00-04:00",
    record_id: "A-1",
  });
  assert.equal(result.employeeExternalId, "E-1");
  assert.equal(result.workDate, "2026-08-10");
  assert.equal(result.clockIn?.utc, "2026-08-10T11:30:00.000Z");
  assert.equal(result.clockIn?.raw, "2026-08-10T07:30:00-04:00");
  assert.equal(result.clockOut?.utc, "2026-08-10T21:00:00.000Z");
  assert.equal(result.externalRecordId, "A-1");
});

test("clock_out ausente (marcación faltante) se conserva como null, nunca se inventa", () => {
  const result = mapWorkeraAttendance({
    employee_id: "E-1",
    date: "2026-08-10",
    clock_in: "2026-08-10T07:30:00-04:00",
    clock_out: null,
  });
  assert.equal(result.clockOut, null);
  assert.equal(result.clockIn?.utc, "2026-08-10T11:30:00.000Z");
});

test("work date se preserva tal cual, sin reinterpretar timezone", () => {
  const result = mapWorkeraAttendance({ employee_id: "E-1", date: "2026-12-25" });
  assert.equal(result.workDate, "2026-12-25");
});

test("sourceUpdatedAt ausente se mapea a null", () => {
  const result = mapWorkeraAttendance({ employee_id: "E-1", date: "2026-08-10" });
  assert.equal(result.sourceUpdatedAt, null);
});

const STATUS_MAPPING: AttendanceStatusMappingTable = { TEST_P: "P" };

test("status_code reconocido se mapea al código interno", () => {
  const result = mapWorkeraAttendanceStatus(
    { employee_id: "E-1", date: "2026-08-10", status_code: "TEST_P" },
    { statusMapping: STATUS_MAPPING }
  );
  assert.equal(result?.code, "P");
  assert.equal(result?.externalCode, "TEST_P");
});

test("status_code no reconocido produce UNKNOWN_EXTERNAL_STATUS, nunca P o F por defecto", () => {
  const result = mapWorkeraAttendanceStatus(
    { employee_id: "E-1", date: "2026-08-10", status_code: "CODIGO_RARO" },
    { statusMapping: STATUS_MAPPING }
  );
  assert.equal(result?.code, "UNKNOWN_EXTERNAL_STATUS");
  assert.equal(result?.externalCode, "CODIGO_RARO");
});

test("status_code ausente produce null (distinto de UNKNOWN_EXTERNAL_STATUS)", () => {
  const result = mapWorkeraAttendanceStatus(
    { employee_id: "E-1", date: "2026-08-10" },
    { statusMapping: STATUS_MAPPING }
  );
  assert.equal(result, null);
});

test("attendanceStatus de Workera se normaliza aunque llegue con mayúsculas/minúsculas", () => {
  const result = mapWorkeraAttendanceEvent({
    employee: { code: "90000017" },
    attendanceDate: "2026-09-01T07:30:00",
    attendanceType: 0,
    attendanceStatus: "Activo",
  });

  assert.equal(result.attendanceStatus, "ACTIVO");
  assert.equal(result.externalAttendanceStatus, "Activo");
});
