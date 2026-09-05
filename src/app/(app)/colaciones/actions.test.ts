import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estática (mismo criterio que `licencias/actions.test.ts` y
 * `licencias/roster-actions.test.ts`): confirma en el código fuente que la
 * creación del Google Form es automática (parte de la MISMA Server Action
 * que valida el menú, sin un paso de clic separado), que la protección de
 * duplicados sigue delegada al `requestId` ya existente (reenviado sin
 * cambios al Apps Script), y que el reintento nunca vuelve a parsear el
 * archivo ni construye un segundo servicio de Google Forms.
 */

const ACTIONS_PATH = path.join(import.meta.dirname, "actions.ts");

function readSource(): string {
  return readFileSync(ACTIONS_PATH, "utf8");
}

test("parseMealMenuAction crea el Google Form automáticamente -- no depende de una segunda acción disparada por un botón", () => {
  const content = readSource();
  const fnStart = content.indexOf("export async function parseMealMenuAction");
  assert.ok(fnStart >= 0, "parseMealMenuAction debe existir");
  const fnEnd = content.indexOf("\nexport async function", fnStart + 1);
  const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /createOrRetryGoogleForm\(/, "parseMealMenuAction debe invocar la creación del formulario dentro de la misma Server Action que valida el menú");
});

test("la creación del formulario usa una única función interna (createOrRetryGoogleForm) que llama a createWeeklyMealGoogleForm -- no hay un segundo servicio de Google Forms", () => {
  const content = readSource();
  const occurrences = content.match(/createWeeklyMealGoogleForm\(/g) ?? [];
  assert.equal(occurrences.length, 1, "createWeeklyMealGoogleForm debe llamarse desde un único lugar (createOrRetryGoogleForm), reutilizado tanto por la subida como por el reintento");
});

test("el requestId se calcula una sola vez a partir del archivo+cierre+recordatorio+nómina -- es la misma protección de duplicados existente, reenviada al Apps Script sin reimplementarla", () => {
  const content = readSource();
  assert.match(content, /createHash\("sha256"\)/);
  const occurrences = content.match(/createHash\(/g) ?? [];
  assert.equal(occurrences.length, 1, "el hash de idempotencia debe calcularse en un único lugar (durante la validación), nunca recalculado en el reintento");
});

test("si la creación falla, conserva el menú y sella el payload en vez de devolver JSON confiado al navegador", () => {
  const content = readSource();
  assert.match(
    content,
    /El menú fue cargado correctamente, pero no fue posible crear el formulario\. Reintentar creación\./,
    "debe usarse el mensaje de error exacto pedido para permitir reintentar sin perder el menú",
  );
  const catchStart = content.indexOf("} catch {", content.indexOf("async function createOrRetryGoogleForm"));
  const catchBlock = content.slice(catchStart, catchStart + 400);
  assert.match(catchBlock, /sealPendingMealFormState\(\{ payload, menu, fileName \}\)/, "el catch debe cifrar y autenticar el estado del reintento");
  assert.match(catchBlock, /pendingToken/, "el catch debe devolver solo el token opaco");
  assert.match(catchBlock, /menu,/, "el catch debe conservar el menú ya validado -- el archivo subido nunca se pierde");
});

test("retryCreateGoogleFormAction abre estado sellado -- nunca confía en JSON, vuelve a parsear el Word ni relee la nómina", () => {
  const content = readSource();
  const fnStart = content.indexOf("export async function retryCreateGoogleFormAction");
  assert.ok(fnStart >= 0, "retryCreateGoogleFormAction debe existir");
  const fnEnd = content.indexOf("\nasync function", fnStart + 1);
  const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.doesNotMatch(fnBody, /parseMealMenuDocx\(/, "el reintento no debe volver a parsear el archivo");
  assert.doesNotMatch(fnBody, /from\("employees"\)/, "el reintento no debe volver a consultar la nómina activa -- reutiliza el payload ya construido");
  assert.doesNotMatch(fnBody, /JSON\.parse|pendingPayload|pendingMenu/, "el reintento no debe aceptar estructuras manipulables desde campos ocultos");
  assert.match(fnBody, /openPendingMealFormState\(pendingToken\)/, "el reintento debe abrir estado autenticado por el servidor");
  assert.match(fnBody, /createOrRetryGoogleForm\(/, "el reintento debe reusar la misma función de creación que la subida original");
});

test("la pantalla no anida formularios ni expone nómina/menú serializados en inputs ocultos", () => {
  const dashboard = readFileSync(path.join(import.meta.dirname, "MenuUploadDashboard.tsx"), "utf8");
  assert.doesNotMatch(dashboard, /JSON\.stringify\(state\./);
  assert.doesNotMatch(dashboard, /name="pendingPayload"|name="pendingMenu"|name="fileName"/);
  assert.match(dashboard, /name="pendingToken"/);
  assert.match(dashboard, /<div className="rounded-lg border border-dashed[\s\S]*?<form action=\{uploadFormAction\}>[\s\S]*?<\/form>[\s\S]*?<form action=\{retryFormAction\}/);
});

test("las Server Actions de colaciones verifican el rol antes de tocar el menú o el formulario", () => {
  const content = readSource();
  for (const fnName of ["parseMealMenuAction", "retryCreateGoogleFormAction"]) {
    const fnStart = content.indexOf(`export async function ${fnName}`);
    const fnEnd = content.indexOf("\nexport async function", fnStart + 1);
    const fnBody = content.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    assert.match(fnBody, /getCurrentProfile\(\)/, `${fnName} debe verificar el perfil antes de continuar`);
    assert.match(fnBody, /isPrivilegedAdmin\(profile\.role\)/, `${fnName} debe restringir a SUPER_ADMIN/ADMIN_RRHH vía el helper compartido isPrivilegedAdmin`);
  }
});
