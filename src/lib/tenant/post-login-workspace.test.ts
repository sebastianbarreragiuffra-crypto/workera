import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspaceDestination } from "./post-login-workspace";
import type { CompanyMembershipSummary } from "./resolve-active-company";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "./legacy-workforce";

function member(overrides: Partial<CompanyMembershipSummary> = {}): CompanyMembershipSummary {
  return {
    companyId: "c1",
    companyName: "Cliente Uno",
    companySlug: "cliente-uno",
    legacyRole: null,
    status: "ACTIVE",
    workspaceEnabled: false,
    ...overrides,
  };
}

test("plataforma tiene precedencia para su OWNER", () => {
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: true,
    legacyProfileRole: "SUPER_ADMIN",
    companies: { kind: "MULTIPLE", memberships: [member(), member({ companyId: "c2" })] },
    expenseCompanyIds: new Set(["c1"]),
  }), "/plataforma");
});

test("una identidad con Arcotex y otra empresa recibe selector, no queda anclada al dashboard", () => {
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: false,
    legacyProfileRole: "ADMIN_RRHH",
    companies: { kind: "MULTIPLE", memberships: [
      member({ companyId: ARCOTEX_WORKFORCE_COMPANY_ID, companySlug: "arcotex", workspaceEnabled: true, legacyRole: "ADMIN_RRHH" }),
      member({ companyId: "c2", companySlug: "otra" }),
    ] },
    expenseCompanyIds: new Set(),
  }), "/empresas");
});

test("una empresa única con workspace laboral conserva su dashboard", () => {
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: false,
    legacyProfileRole: "ADMIN_RRHH",
    companies: { kind: "SINGLE", membership: member({ companyId: ARCOTEX_WORKFORCE_COMPANY_ID, companySlug: "arcotex", workspaceEnabled: true, legacyRole: "ADMIN_RRHH" }) },
    expenseCompanyIds: new Set([ARCOTEX_WORKFORCE_COMPANY_ID]),
  }), "/dashboard");
});

test("un tenant no Arcotex recibe el workspace laboral cuando está habilitado", () => {
  const companies = {
    kind: "SINGLE" as const,
    membership: member({ companySlug: "cliente-renombrado", workspaceEnabled: true, legacyRole: "ADMIN_RRHH" }),
  };
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: false,
    legacyProfileRole: "ADMIN_RRHH",
    companies,
    expenseCompanyIds: new Set(),
  }), "/dashboard");
});

test("el rol laboral de la membresía basta aunque el perfil global no tenga rol legacy", () => {
  const companies = {
    kind: "SINGLE" as const,
    membership: member({ workspaceEnabled: true, legacyRole: "SUPERVISOR_PRODUCTION" }),
  };
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: false,
    legacyProfileRole: null,
    companies,
    expenseCompanyIds: new Set(),
  }), "/dashboard");
});

test("una empresa en onboarding no abre el workspace laboral aunque tenga rol y flag", () => {
  const companies = {
    kind: "SINGLE" as const,
    membership: member({ status: "ONBOARDING", workspaceEnabled: true, legacyRole: "ADMIN_RRHH" }),
  };
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: false,
    legacyProfileRole: "ADMIN_RRHH",
    companies,
    expenseCompanyIds: new Set(),
  }), "/empresas/cliente-uno");
});

test("tenant único con Rendiciones entra al módulo y sin módulo entra a su portada", () => {
  const companies = { kind: "SINGLE" as const, membership: member() };
  assert.equal(resolveWorkspaceDestination({ hasPlatformMembership: false, legacyProfileRole: null, companies, expenseCompanyIds: new Set(["c1"]) }), "/empresas/cliente-uno/rendiciones");
  assert.equal(resolveWorkspaceDestination({ hasPlatformMembership: false, legacyProfileRole: null, companies, expenseCompanyIds: new Set() }), "/empresas/cliente-uno");
});

test("sesión sin empresa queda pendiente y nunca vuelve al login", () => {
  assert.equal(resolveWorkspaceDestination({
    hasPlatformMembership: false,
    legacyProfileRole: "SUPER_ADMIN",
    companies: { kind: "NONE" },
    expenseCompanyIds: new Set(),
  }), "/acceso-pendiente");
});
