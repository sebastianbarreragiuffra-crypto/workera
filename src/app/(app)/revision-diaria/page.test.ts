import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const revisionPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("revision diaria mejora navegación de fecha con foco visible y estado actual", () => {
  assert.ok(revisionPage.includes('aria-label="Día anterior"'), "Debe incluir el botón de día anterior");
  assert.ok(revisionPage.includes("focus-visible:outline-arcotex-blue"), "Debe incluir foco visible en la navegación de fecha");
  assert.ok(revisionPage.includes('aria-label="Día siguiente"'), "Debe incluir el botón de día siguiente");
  assert.ok(revisionPage.includes('aria-current={date === today ? "page" : undefined}'), "Debe indicar estado actual en el botón de Hoy");
  assert.ok(!revisionPage.includes("title={AREA_LABEL[area]}"), "No debe repetir el texto visible de área con title");
  const todayCalls = revisionPage.match(/todayInSantiago\(\)/g)?.length ?? 0;
  assert.equal(todayCalls, 1, "Debe existir una sola llamada explícita a todayInSantiago()");
});

test("revision diaria usa area activa con aria-current y enlaces que envuelven en móvil", () => {
  assert.match(revisionPage, /<nav aria-label=\"Área\" className=\"flex flex-wrap gap-2\">/);
  assert.match(revisionPage, /aria-current=\{area === requestedArea \? \"page\" : undefined\}/);
  assert.ok(revisionPage.includes('className={`rounded-md px-3 py-1.5 text-sm font-medium ${'), "Debe conservar clase base para el pill de área activa/inactiva");
  assert.ok(!revisionPage.includes('role="tab"'), "No debe renderizar role=\"tab\" sin patrón de pestañas completo");
  assert.ok(revisionPage.includes("const date = params.fecha && isCalendarDate(params.fecha) ? params.fecha : today;"), "Debe resolver date con fallback `today`");
  assert.ok(revisionPage.includes("const today = todayInSantiago();"), "Debe calcular `today` una sola vez y antes de resolver date");
});

test("revision diaria expone semántica y conteo accesible en su progreso", () => {
  assert.ok(revisionPage.includes('role="progressbar"'), "La barra visual debe exponerse como progreso");
  assert.ok(revisionPage.includes('aria-label="Progreso de revisión diaria"'));
  assert.ok(revisionPage.includes("aria-valuenow={progressPct}"));
  assert.ok(revisionPage.includes("aria-valuetext={`${completed} de ${total}"));
});
