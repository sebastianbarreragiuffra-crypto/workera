import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática (mismo criterio que `actions.test.ts`/`roster-actions.test.ts`
 * -- este codebase no usa jsdom/testing-library, así que la estructura de UI
 * se verifica sobre el código fuente) del rediseño compacto de /licencias:
 * las dos tarjetas superiores van lado a lado en desktop, la tarjeta de
 * licencias activas es un KPI simple con color derivado (nunca hardcodeado),
 * y la subida de licencia ya no pide fechas manuales.
 */

const DIR = import.meta.dirname;
const readSource = (file: string) => readFileSync(path.join(DIR, file), "utf8");

test("page.tsx: 'Licencias activas' y 'Subir licencia médica' están en la MISMA fila (grid de 2 columnas en desktop, 1 en mobile)", () => {
  const content = readSource("page.tsx");
  const gridStart = content.indexOf('<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">');
  assert.ok(gridStart >= 0, "debe existir un contenedor grid-cols-1 lg:grid-cols-2 (mobile apilado, desktop lado a lado)");
  const gridEnd = content.indexOf("</div>", content.indexOf("</div>", gridStart) + 1);
  const gridBody = content.slice(gridStart, gridEnd);
  assert.match(gridBody, /title="Licencias activas"/);
  assert.match(gridBody, /<UploadLicenseCard/);
});

test("page.tsx: el KPI de licencias activas usa el conteo real (activeNowCount) y un tono derivado -- nunca un número o color fijo", () => {
  const content = readSource("page.tsx");
  assert.match(content, /getActiveLicenseKpiTone\(summary\.activeNowCount\)/);
  assert.match(content, /\{summary\.activeNowCount\}/);
});

test("page.tsx: la tarjeta de licencias activas ya no muestra pendientes/aprobadas/rechazadas -- solo el conteo simple", () => {
  const content = readSource("page.tsx");
  const cardStart = content.indexOf('title="Licencias activas"');
  const cardEnd = content.indexOf("</SectionCard>", cardStart);
  const cardBody = content.slice(cardStart, cardEnd);
  assert.doesNotMatch(cardBody, /pendientes de aprobación/i);
  assert.doesNotMatch(cardBody, /aprobadas \(total\)/i);
  assert.doesNotMatch(cardBody, /rechazadas \(total\)/i);
});

test("medical-license-kpi: 0 licencias activas -> tono 'healthy' (verde); 1+ -> 'attention' (ámbar); nunca 'red'/crítico", () => {
  const content = readSource(path.join("..", "..", "..", "lib", "decisions", "medical-license-kpi.ts"));
  assert.match(content, /activeLicenseCount === 0 \? "healthy" : "attention"/);
});

test("page.tsx: el tono KPI se traduce a clases success (verde) / warning (ámbar) -- nunca a critical/red", () => {
  const content = readSource("page.tsx");
  const mapStart = content.indexOf("KPI_TONE_CLASS");
  const mapBody = content.slice(mapStart, content.indexOf("};", mapStart));
  assert.match(mapBody, /healthy:.*success/);
  assert.match(mapBody, /attention:.*warning/);
  assert.doesNotMatch(mapBody, /critical/);
});

test("LicenciasDashboard.tsx: UploadLicenseCard ya no tiene inputs de fecha de inicio/término", () => {
  const content = readSource("LicenciasDashboard.tsx");
  const fnStart = content.indexOf("export function UploadLicenseCard");
  const nextExport = content.indexOf("\nexport function", fnStart + 1);
  const nextPlain = content.indexOf("\nfunction ", fnStart + 1);
  const fnEnd = [nextExport, nextPlain].filter((i) => i > 0).sort((a, b) => a - b)[0];
  const fnBody = content.slice(fnStart, fnEnd ?? undefined);
  assert.doesNotMatch(fnBody, /name="startDate"/);
  assert.doesNotMatch(fnBody, /name="endDate"/);
  assert.doesNotMatch(fnBody, /type="date"/);
});

test("LicenciasDashboard.tsx: UploadLicenseCard conserva el selector de trabajador, el input de archivo y el botón de subir", () => {
  const content = readSource("LicenciasDashboard.tsx");
  const fnStart = content.indexOf("export function UploadLicenseCard");
  const nextExport = content.indexOf("\nexport function", fnStart + 1);
  const nextPlain = content.indexOf("\nfunction ", fnStart + 1);
  const fnEnd = [nextExport, nextPlain].filter((i) => i > 0).sort((a, b) => a - b)[0];
  const fnBody = content.slice(fnStart, fnEnd ?? undefined);
  assert.match(fnBody, /name="employeeId"/);
  assert.match(fnBody, /name="file"/);
  assert.match(fnBody, /Subir licencia/);
});

test("actions.ts: uploadMedicalLicenseAction ya no lee startDate/endDate del formData -- usa extractMedicalLicenseDates sobre el documento", () => {
  const content = readSource("actions.ts");
  const fnStart = content.indexOf("export async function uploadMedicalLicenseAction");
  const fnEnd = content.indexOf("\nexport interface", fnStart + 1);
  const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.doesNotMatch(fnBody, /formData\.get\(["']startDate["']\)/);
  assert.doesNotMatch(fnBody, /formData\.get\(["']endDate["']\)/);
  assert.match(fnBody, /extractMedicalLicenseDates\(/);
});

test("actions.ts: subir una licencia nunca llama a nada de aprobación -- solo approveMedicalLicenseAction puede generar 'L'", () => {
  const content = readSource("actions.ts");
  const uploadStart = content.indexOf("export async function uploadMedicalLicenseAction");
  const uploadEnd = content.indexOf("\nexport interface", uploadStart + 1);
  const uploadBody = content.slice(uploadStart, uploadEnd === -1 ? undefined : uploadEnd);
  assert.doesNotMatch(uploadBody, /approveMedicalLicense\(/, "subir un documento nunca debe aprobar la licencia ni generar asistencia L");
});

test("RosterImportCard.tsx: la tarjeta de roster es compacta -- sin el párrafo largo anterior, con texto breve", () => {
  const content = readSource("RosterImportCard.tsx");
  assert.doesNotMatch(content, /Apellidos, Nombres, R\.U\.T\./, "el párrafo explicativo largo debe haberse reemplazado por un texto breve");
  assert.match(content, /Sube la planilla actualizada de trabajadores para revisar cambios antes de aplicarlos\./);
});

test("RosterImportCard.tsx: un único <input type=\"file\"> compartido -- 'Ver cambios' y 'Confirmar actualización de roster' usan formAction sobre el mismo input, sin un segundo input oculto clonado por DataTransfer", () => {
  const content = readSource("RosterImportCard.tsx");
  const codeOnly = content.replace(/\/\*\*[\s\S]*?\*\//g, "");
  const fileInputCount = (codeOnly.match(/<input[^>]*type="file"/g) ?? []).length;
  assert.equal(fileInputCount, 1, "debe existir un único input de archivo -- el input oculto duplicado era la causa raíz de que 'Confirmar' no hiciera nada visible");
  assert.doesNotMatch(codeOnly, /DataTransfer/, "no debe depender de clonar el archivo entre inputs vía DataTransfer");
  assert.doesNotMatch(codeOnly, /useEffect/, "no debe depender de un useEffect para sincronizar el archivo entre dos forms");
  assert.match(content, /formAction=\{previewAction\}/);
  assert.match(content, /formAction=\{applyAction\}/);
});
