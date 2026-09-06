import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx-js-style";
import { comparePayrollWorkbooks, inspectXlsxContainer, parsePayrollWorkbook } from "./payroll-workbook-upload";

function workbook(value = 0, formula = "Q6+R6/1440"): Uint8Array {
  const book = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ["Título"], [], [], [],
    ["Estado", "RUT", "Nombre completo", "Área", "Centro de costo", "Jornada", "Días con presencia", "Horas ordinarias registradas", "HH50 pagables", "HH100 pagables", "Atrasos descontables", "Salidas anticipadas descontables", "Días con bono", "Bono total", "Pendientes", "Observaciones", "HH50 reales", "Ajuste HH50 (minutos)", "Motivo ajuste HH50", "HH100 reales", "Ajuste HH100 (minutos)", "Motivo ajuste HH100", "Bono HE automático", "Ajuste bono (CLP)", "Motivo ajuste bono", "Fechas de bono", "Fechas pendientes", "Código Workera", "Identificador técnico"],
    ["REVISAR", "11111111-1", "Persona prueba", "Producción", "CC", "08:00-17:00", 1, 8 / 24, value, 0, 0, 0, 0, 0, 0, "", 0, 0, "", 0, 0, "", 0, 0, "", "", "", "WK-1", "emp-1"],
  ]);
  summary.I6.f = formula;
  XLSX.utils.book_append_sheet(book, summary, "RESUMEN_NOMINA");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Pendientes"]]), "CONTROL_PENDIENTES");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Matriz"]]), "MATRIZ_DIARIA_SABANA");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Esquema", "GESTORA_PRENOMINA_2026_V2"], ["Tipo de período", "PAGO"], ["Inicio", "2026-07-16"], ["Fin", "2026-08-15"], ["Mes de remuneración", "2026-08"], ["Versión base", "2"]]), "_GESTORA_TECNICA");
  const written = XLSX.write(book, { type: "array", bookType: "xlsx", compression: true }) as Uint8Array | ArrayBuffer;
  return written instanceof Uint8Array ? written : new Uint8Array(written);
}

test("subida XLSX: valida identidad, hash y cambio por clave estable", () => {
  const base = workbook(); const changed = workbook(1 / 24);
  const preview = comparePayrollWorkbooks(base, changed);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.identity.payrollMonth, "2026-08");
  const change = preview.changes.find((item) => item.cell === "I6");
  assert.equal(change?.stableKey, "emp-1|HH50 pagables");
  assert.equal(change?.consequence, "AJUSTE_EMPRESARIAL");
});

test("subida XLSX: fórmula se conserva en archivo pero no se ejecuta como dato", () => {
  const preview = comparePayrollWorkbooks(workbook(), workbook(0, "1+1"));
  const change = preview.changes.find((item) => item.kind === "FORMULA");
  assert.equal(change?.consequence, "CONSERVAR_ARCHIVO_SIN_EJECUTAR");
});

test("subida XLSX: repetición idéntica es idempotente", () => {
  const bytes = workbook();
  assert.equal(comparePayrollWorkbooks(bytes, bytes).changes.length, 0);
  assert.equal(parsePayrollWorkbook(bytes).sha256, parsePayrollWorkbook(bytes).sha256);
});

test("subida XLSX: rechaza archivo corrupto o sin firma ZIP", () => {
  assert.throws(() => inspectXlsxContainer(new Uint8Array([1, 2, 3, 4])), /firma/);
});
