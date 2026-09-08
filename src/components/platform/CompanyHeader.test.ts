import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const headerSource = readFileSync(new URL("./CompanyHeader.tsx", import.meta.url), "utf8");
const companyPageSource = readFileSync(
  new URL("../../app/(platform)/plataforma/empresas/[companySlug]/page.tsx", import.meta.url),
  "utf8",
);

test("la ficha de Arcotex presenta el padrón autorizado, no el total técnico heredado", () => {
  assert.match(headerSource, /employeeMetric\?\.label \?\? "Trabajadores"/);
  assert.match(headerSource, /employeeMetric\?\.value \?\? company\.employeeCount/);
  assert.match(companyPageSource, /detail\.header\.slug === "arcotex"/);
  assert.match(companyPageSource, /label: "Padrón autorizado"/);
  assert.match(companyPageSource, /requireArcotexAuthorizedRoster\(process\.env\.ARCOTEX_PILOT_EMPLOYEE_IDS\)\.employeeCount/);
});
