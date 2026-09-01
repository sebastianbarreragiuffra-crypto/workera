import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const authorizeSource = readFileSync(fileURLToPath(new URL("./authorize.ts", import.meta.url)), "utf8");
const sessionSource = readFileSync(fileURLToPath(new URL("../auth/session.ts", import.meta.url)), "utf8");
const documentsActionsSource = readFileSync(fileURLToPath(new URL("../../app/(app)/documentos/actions.ts", import.meta.url)), "utf8");
const dailyReviewActionsSource = readFileSync(fileURLToPath(new URL("../../app/(app)/revision-diaria/actions.ts", import.meta.url)), "utf8");

test("los gates de rol y licencia consultan y exigen profiles.active", () => {
  assert.match(authorizeSource, /select\("role, active"\)/);
  assert.match(authorizeSource, /!profile\?\.active/);
  assert.match(authorizeSource, /select\("role, active, medical_license_approver"\)/);
});

test("getCurrentProfile solo devuelve perfiles activos para páginas, actions y route handlers", () => {
  assert.match(sessionSource, /\.eq\("active", true\)/);
  assert.match(sessionSource, /\.maybeSingle\(\)/);
});

test("documentos autoriza antes de leer archivos o generar signed URLs", () => {
  for (const actionName of ["uploadGeneralDocumentAction", "viewDocumentAction"]) {
    const start = documentsActionsSource.indexOf(`export async function ${actionName}`);
    assert.notEqual(start, -1, `${actionName} debe existir`);
    const body = documentsActionsSource.slice(start, documentsActionsSource.indexOf("\n}", start) + 2);
    assert.ok(body.indexOf("await requireActiveProfile()") >= 0, `${actionName} debe exigir profile activo`);
    assert.ok(body.indexOf("await requireActiveProfile()") < body.indexOf("await createClient()"), `${actionName} debe autorizar antes de crear el cliente`);
  }
});

test("todas las acciones de revisión diaria autorizan antes de operar", () => {
  const actionNames = [
    "decideLateArrivalAction",
    "decideOvertimeAction",
    "markEarlyDepartureMedicalAction",
    "confirmEarlyDepartureMedicalDocumentAction",
    "decideEarlyDepartureOtherAction",
    "markAbsencePendingDocumentAction",
    "confirmAbsenceDocumentAction",
    "disputeAbsenceAction",
    "uploadDocumentAction",
  ];

  for (const actionName of actionNames) {
    const start = dailyReviewActionsSource.indexOf(`export async function ${actionName}`);
    assert.notEqual(start, -1, `${actionName} debe existir`);
    const nextExport = dailyReviewActionsSource.indexOf("export async function ", start + 1);
    const body = dailyReviewActionsSource.slice(start, nextExport === -1 ? undefined : nextExport);
    assert.ok(body.indexOf("await requireActiveProfile()") >= 0, `${actionName} debe exigir profile activo`);
    assert.ok(body.indexOf("await requireActiveProfile()") < body.indexOf("await createClient()"), `${actionName} debe autorizar antes de crear el cliente`);
  }
});
