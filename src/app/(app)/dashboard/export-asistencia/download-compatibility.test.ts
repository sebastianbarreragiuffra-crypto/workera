import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { strFromU8, unzipSync } from "fflate";
import { buildAttendanceExportWorkbook, type AttendanceExportData } from "../../../../lib/business-rules/attendance-export";
import { attendanceWorkbookHeaders } from "./route-utils";

const DATA: AttendanceExportData = {
  period: {
    type: "SEMANAL",
    startDate: "2026-09-07",
    endDate: "2026-09-07",
    label: "Semana de compatibilidad",
  },
  days: ["2026-09-07"],
  workers: [
    {
      employeeId: "00000000-0000-4000-8000-000000000001",
      employeeCode: "WK-001",
      employeeRut: "11.111.111-1",
      workerName: "PERSONA DE PRUEBA",
      area: "PRODUCTION",
      costCenter: "PRODUCCION",
      days: new Map(),
      hireDate: null,
      currentlyActive: true,
      scheduledWeekdays: new Set([1]),
      scheduleCoveredDates: new Set(["2026-09-07"]),
      scheduledDates: new Set(["2026-09-07"]),
      exemptDates: new Set(),
      scheduleLabel: "07:30-17:00",
    },
  ],
  holidays: new Set(),
  reportingPeriodStatus: null,
  ruleEngineProblemDates: new Set(),
  companyId: "11111111-1111-4111-8111-111111111111",
};

// Contrato estructural del binario y sus cabeceras. La apertura real en Excel
// 2013 sigue siendo un control manual del piloto y no se simula en esta prueba.
test("contrato binario de descarga: entrega un XLSX íntegro sin extensiones posteriores a Excel 2013", async () => {
  const generated = buildAttendanceExportWorkbook(DATA);
  const headers = attendanceWorkbookHeaders("pre-nomina-arcotex.xlsx", generated.byteLength);
  const response = new Response(Buffer.from(generated), { status: 200, headers });
  const downloaded = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(downloaded.byteLength));
  assert.equal(
    response.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.deepEqual([...downloaded.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "firma ZIP de un XLSX");

  const archive = unzipSync(downloaded);
  const paths = Object.keys(archive);
  assert.equal(paths.filter((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path)).length, 4);
  assert.equal(paths.some((path) => /^xl\/metadata\d*\.xml$/.test(path)), false);
  assert.doesNotMatch(strFromU8(archive["[Content_Types].xml"]), /sheetMetadata/i);

  const formulas = paths
    .filter((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path))
    .map((path) => strFromU8(archive[path]))
    .join("\n");
  assert.match(formulas, /<f[ >]/, "la prueba debe cubrir formulas reales del libro");
  assert.doesNotMatch(formulas, /_xlfn\./i, "no debe exigir funciones posteriores a Excel 2013");

  const workbook = XLSX.read(downloaded, { type: "array", cellFormula: true });
  assert.deepEqual(workbook.SheetNames, [
    "RESUMEN_NOMINA",
    "CONTROL_PENDIENTES",
    "MATRIZ_DIARIA_SABANA",
    "_GESTORA_TECNICA",
  ]);
});
