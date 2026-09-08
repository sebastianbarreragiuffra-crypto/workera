import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isOperationalWorkforceMembership,
  selectActiveWorkforceCompany,
  workforceEntryPathForCompany,
} from "./active-workforce-company";
import type { CompanyMembershipSummary } from "./resolve-active-company";

function membership(overrides: Partial<CompanyMembershipSummary> = {}): CompanyMembershipSummary {
  return {
    companyId: "11111111-1111-4111-8111-111111111111",
    companyName: "Empresa Uno",
    companySlug: "empresa-uno",
    legacyRole: "ADMIN_RRHH",
    status: "ACTIVE",
    workspaceEnabled: true,
    ...overrides,
  };
}

test("empresa laboral activa: una selección solo vale si sigue siendo una membresía operativa", () => {
  const first = membership();
  const second = membership({
    companyId: "22222222-2222-4222-8222-222222222222",
    companyName: "Empresa Dos",
    companySlug: "empresa-dos",
    legacyRole: "SUPERVISOR_PRODUCTION",
  });
  const resolution = { kind: "MULTIPLE" as const, memberships: [first, second] };

  assert.equal(selectActiveWorkforceCompany(resolution, second.companyId)?.companyId, second.companyId);
  assert.equal(selectActiveWorkforceCompany(resolution, "33333333-3333-4333-8333-333333333333"), null);
  assert.equal(selectActiveWorkforceCompany(resolution, null), null);
});

test("empresa laboral activa: una sola membresía operativa funciona sin cookie para conservar compatibilidad", () => {
  const only = membership();
  assert.equal(selectActiveWorkforceCompany({ kind: "SINGLE", membership: only }, null), only);
});

test("empresa laboral activa: onboarding, workspace bloqueado y rol ausente nunca habilitan asistencia", () => {
  assert.equal(isOperationalWorkforceMembership(membership({ status: "ONBOARDING" })), false);
  assert.equal(isOperationalWorkforceMembership(membership({ workspaceEnabled: false })), false);
  assert.equal(isOperationalWorkforceMembership(membership({ legacyRole: null })), false);
});

test("navegación laboral: solo genera la entrada para la empresa exacta autorizada", () => {
  const arcotex = membership({ companyName: "Arcotex", companySlug: "arcotex" });
  const otra = membership({
    companyId: "22222222-2222-4222-8222-222222222222",
    companyName: "Empresa sintética",
    companySlug: "empresa-sintetica",
  });
  const resolution = { kind: "MULTIPLE" as const, memberships: [arcotex, otra] };

  assert.equal(workforceEntryPathForCompany(resolution, " ARCOTEX "), "/empresas/arcotex/personas");
  assert.equal(workforceEntryPathForCompany(resolution, "empresa-no-autorizada"), null);
});

test("navegación laboral: nunca ofrece dashboard para una membresía no operativa", () => {
  for (const blocked of [
    membership({ status: "ONBOARDING" }),
    membership({ workspaceEnabled: false }),
    membership({ legacyRole: null }),
  ]) {
    assert.equal(
      workforceEntryPathForCompany({ kind: "SINGLE", membership: blocked }, blocked.companySlug),
      null,
    );
  }
});

test("empresa laboral activa: la ruta de selección reautoriza y guarda una cookie HttpOnly", () => {
  const route = readFileSync(path.join(
    process.cwd(),
    "src", "app", "(expenses)", "empresas", "[companySlug]", "personas", "route.ts",
  ), "utf8");
  assert.match(route, /resolveActiveCompany\(supabase\)/);
  assert.match(route, /isOperationalWorkforceMembership\(item\)/);
  assert.match(route, /response\.cookies\.set\(ACTIVE_WORKFORCE_COMPANY_COOKIE/);
  assert.match(route, /httpOnly: true/);
  assert.match(route, /sameSite: "lax"/);
});

test("empresa laboral activa: las rutas críticas ya no contienen el UUID fijo de Arcotex", () => {
  const sources = [
    ["src", "app", "(app)", "layout.tsx"],
    ["src", "app", "(app)", "dashboard", "page.tsx"],
    ["src", "app", "(app)", "dashboard", "export-asistencia", "route.ts"],
    ["src", "app", "(app)", "dashboard", "import-asistencia", "route.ts"],
    ["src", "app", "(app)", "periodos", "actions.ts"],
    ["src", "app", "(app)", "configuracion", "horarios", "actions.ts"],
    ["src", "app", "(app)", "configuracion", "motor-de-reglas", "actions.ts"],
    ["src", "app", "(app)", "revision-diaria", "actions.ts"],
  ];
  for (const segments of sources) {
    const source = readFileSync(path.join(process.cwd(), ...segments), "utf8");
    assert.doesNotMatch(source, /ARCOTEX_WORKFORCE_COMPANY_ID|0a4c0000-0000-0000-0000-000000000001/);
    assert.match(source, /resolveActiveWorkforceCompany/);
  }
});
