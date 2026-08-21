import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática (mismo criterio que `actions.test.ts`) del fix de
 * rendimiento: las llamadas a Google Forms (cada una con su propio timeout
 * de 20s en `google-forms.ts`, nunca tocado acá) ya NO corren en el cuerpo
 * directo de `ColacionesPage` -- antes cualquier demora ahí bloqueaba el
 * streaming de TODO el HTML de la página, incluido el layout/nav, al hacer
 * clic en "Colaciones" en el menú. Ahora quedan detrás de un `<Suspense>`
 * en un componente async aparte, así el shell de la página siempre llega
 * de inmediato. El Excel de descuentos (antes filesystem local, ahora
 * Supabase Storage) se movió AL MISMO componente async por el mismo motivo
 * -- dejó de ser una lectura instantánea de disco y pasó a ser una descarga
 * real, así que ya no debe bloquear la respuesta inicial tampoco.
 */
const PAGE_PATH = path.join(import.meta.dirname, "page.tsx");
const readSource = () => readFileSync(PAGE_PATH, "utf8");

test("ColacionesPage (el componente exportado por default) NO llama directamente a listWeeklyMealGoogleForms/getWeeklyMealGoogleFormStatus/getActiveDiscountWorkbookDataset -- esas llamadas viven en un componente separado", () => {
  const content = readSource();
  const pageStart = content.indexOf("export default async function ColacionesPage");
  const pageEnd = content.indexOf("\nfunction ColacionesLoadingFallback", pageStart);
  const pageBody = content.slice(pageStart, pageEnd === -1 ? undefined : pageEnd);
  assert.doesNotMatch(pageBody, /listWeeklyMealGoogleForms\(/, "ColacionesPage no debe esperar el listado de Google Forms directamente");
  assert.doesNotMatch(pageBody, /getWeeklyMealGoogleFormStatus\(/, "ColacionesPage no debe esperar el status de Google Forms directamente");
  assert.doesNotMatch(pageBody, /getActiveDiscountWorkbookDataset\(/, "ColacionesPage no debe esperar la descarga del Excel de Storage directamente");
});

test("ColacionesPage ya NO depende del filesystem local (getProductionMealDiscountDataset / DESCUENTO DE COLACIONES.xlsx) -- bloqueador de Vercel resuelto", () => {
  const content = readSource();
  assert.doesNotMatch(content, /getProductionMealDiscountDataset/, "esa función (lectura de disco) fue reemplazada por Supabase Storage");
  assert.doesNotMatch(content, /DESCUENTO DE COLACIONES\.xlsx/, "el nombre del archivo local no debe quedar hardcodeado en el runtime");
  assert.doesNotMatch(content, /process\.cwd\(\)/, "no debe quedar ninguna lectura basada en el directorio de trabajo del proceso");
  assert.match(content, /getActiveDiscountWorkbookDataset/, "debe usar la nueva fuente compartida (Storage)");
});

test("ColacionesPage envuelve la sección dependiente de Google Forms en <Suspense> con un fallback visible", () => {
  const content = readSource();
  const pageStart = content.indexOf("export default async function ColacionesPage");
  const pageEnd = content.indexOf("\nfunction ColacionesLoadingFallback", pageStart);
  const pageBody = content.slice(pageStart, pageEnd === -1 ? undefined : pageEnd);
  assert.match(pageBody, /<Suspense fallback=\{<ColacionesLoadingFallback \/>\}>/);
  assert.match(pageBody, /<ColacionesGoogleFormsSection/);
});

test("ColacionesGoogleFormsSection sigue produciendo exactamente los mismos props que ColacionesDashboard esperaba antes -- no cambia el contrato ni la lógica de negocio", () => {
  const content = readSource();
  const sectionStart = content.indexOf("async function ColacionesGoogleFormsSection");
  assert.ok(sectionStart >= 0);
  const sectionBody = content.slice(sectionStart);
  for (const prop of ["discountDataset", "discountError", "discountWorkbookMeta", "recentForms", "formsError", "activeForm", "formBusinessState", "responseTracking", "trackingError"]) {
    assert.match(sectionBody, new RegExp(`${prop}=\\{${prop}\\}`), `ColacionesDashboard debe seguir recibiendo ${prop}`);
  }
  assert.match(sectionBody, /getMealFormBusinessState\(/, "la lógica de negocio (getMealFormBusinessState) no cambió, solo se movió de lugar");
  assert.match(sectionBody, /buildMealResponseTracking\(/, "la lógica de negocio (buildMealResponseTracking) no cambió, solo se movió de lugar");
});

test("la consulta a employees se dispara ANTES de esperar listWeeklyMealGoogleForms -- corre en paralelo, no encadenada innecesariamente", () => {
  const content = readSource();
  const sectionStart = content.indexOf("async function ColacionesGoogleFormsSection");
  const sectionBody = content.slice(sectionStart);
  const employeesPromiseIdx = sectionBody.indexOf("const employeesPromise =");
  const listAwaitIdx = sectionBody.indexOf("await listWeeklyMealGoogleForms()");
  assert.ok(employeesPromiseIdx >= 0 && listAwaitIdx >= 0);
  assert.ok(employeesPromiseIdx < listAwaitIdx, "employeesPromise debe dispararse antes de esperar el listado de Google Forms, para correr en paralelo");
});

test("la descarga del Excel de descuentos (Storage) se dispara ANTES de esperar listWeeklyMealGoogleForms -- corre en paralelo con Google Forms, no bloquea ni queda bloqueada por eso", () => {
  const content = readSource();
  const sectionStart = content.indexOf("async function ColacionesGoogleFormsSection");
  const sectionBody = content.slice(sectionStart);
  const discountPromiseIdx = sectionBody.indexOf("const discountDatasetPromise =");
  const listAwaitIdx = sectionBody.indexOf("await listWeeklyMealGoogleForms()");
  assert.ok(discountPromiseIdx >= 0 && listAwaitIdx >= 0);
  assert.ok(discountPromiseIdx < listAwaitIdx, "discountDatasetPromise debe dispararse antes de esperar el listado de Google Forms, para correr en paralelo");
});
