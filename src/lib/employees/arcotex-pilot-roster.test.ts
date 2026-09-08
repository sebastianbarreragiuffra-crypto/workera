import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  authorizedRosterForCompany,
  canonicalRosterSha256,
  requireArcotexAuthorizedRoster,
} from "./arcotex-pilot-roster";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../tenant/legacy-workforce";

const ids = Array.from({ length: ARCOTEX_AUTHORIZED_ROSTER_SIZE }, (_, index) =>
  `a7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

test("padrón autorizado Arcotex: acepta exactamente los 45 UUID únicos configurados", () => {
  assert.deepEqual(requireArcotexAuthorizedRoster(ids.join(",")), {
    employeeIds: ids,
    employeeCount: 45,
    expectedEmployeeCodeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  });
});

test("padrón autorizado Arcotex: sin configuración bloquea las planillas en vez de incluir el padrón completo", () => {
  assert.throws(() => requireArcotexAuthorizedRoster(undefined), /permanecen bloqueadas/);
  assert.throws(() => requireArcotexAuthorizedRoster("   "), /permanecen bloqueadas/);
});

test("padrón autorizado Arcotex: falla cerrado ante 44, 46, duplicados o IDs inválidos", () => {
  assert.throws(() => requireArcotexAuthorizedRoster(ids.slice(0, 44).join(",")), /exactamente 45/);
  assert.throws(() => requireArcotexAuthorizedRoster([...ids, "a7000000-0000-4000-8000-000000000046"].join(",")), /exactamente 45/);
  assert.throws(() => requireArcotexAuthorizedRoster([...ids.slice(0, 44), ids[0]].join(",")), /exactamente 45/);
  assert.throws(() => requireArcotexAuthorizedRoster([...ids.slice(0, 44), "no-es-uuid"].join(",")), /identificador inválido/);
});

test("padrón autorizado Arcotex: la huella canónica detecta sustituciones aunque el conteo siga en 45", () => {
  const original = canonicalRosterSha256(ids);
  const substituted = canonicalRosterSha256([...ids.slice(0, 44), "a7000000-0000-4000-8000-999999999999"]);
  assert.notEqual(original, substituted);
});

test("padrón autorizado Arcotex: solo se exige al UUID fijo de ARCOTEX", () => {
  assert.equal(authorizedRosterForCompany("b7000000-0000-4000-8000-000000000001", undefined), undefined);
  assert.equal(
    authorizedRosterForCompany(ARCOTEX_WORKFORCE_COMPANY_ID, ids.join(","))?.employeeCount,
    45,
  );
});
