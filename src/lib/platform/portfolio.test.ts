import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PlatformDataAccessError,
  buildOrganizationTree,
  deriveOnboardingSummary,
  mapAuditItems,
  mapInvitationItems,
  mapMemberItems,
  mapModuleItems,
  mapOnboardingSteps,
  mapOrganizationProjection,
  mapPortfolioRows,
  mapRoleItems,
  type PlatformPortfolioRow,
} from "./portfolio";

const portfolioRow: PlatformPortfolioRow = {
  active_members: "3",
  available_modules: 10,
  company_id: "company-1",
  completed_steps: 2,
  created_at: "2026-08-31T10:00:00Z",
  employee_count: 44,
  enabled_modules: 4,
  legal_name: "Cliente Uno SpA",
  name: "Cliente Uno",
  next_step_label: "Organización",
  plan_code: "CUSTOM",
  slug: "cliente-uno",
  status: "ONBOARDING",
  total_members: 5,
  total_steps: 8,
  workspace_enabled: false,
};

test("mapPortfolioRows entrega DTO mínimo, conteos y href estable", () => {
  const [item] = mapPortfolioRows([portfolioRow]);
  assert.deepEqual(item, {
    id: "company-1",
    name: "Cliente Uno",
    slug: "cliente-uno",
    status: "ONBOARDING",
    onboarding: {
      status: "IN_PROGRESS",
      completedSteps: 2,
      totalSteps: 8,
      nextStepLabel: "Organización",
    },
    users: { active: 3, total: 5 },
    modules: { enabled: 4, available: 10 },
    detailHref: "/plataforma/empresas/cliente-uno",
  });
  assert.equal("legal_name" in item, false, "el DTO de cartera no filtra columnas internas del RPC");
});

test("estado BLOCKED prevalece y un onboarding vacío queda NOT_STARTED", () => {
  assert.equal(mapPortfolioRows([portfolioRow], new Set(["company-1"]))[0].onboarding.status, "BLOCKED");
  assert.deepEqual(deriveOnboardingSummary({ completedSteps: 0, totalSteps: 0 }), {
    status: "NOT_STARTED",
    completedSteps: 0,
    totalSteps: 0,
    nextStepLabel: null,
  });
});

test("mapOnboardingSteps conserva checklist real, orden y valores todavía no iniciados", () => {
  const steps = mapOnboardingSteps(
    [
      {
        step_key: "security",
        status: "BLOCKED",
        notes: "Falta aislamiento",
        completed_at: null,
      },
    ],
    [
      { key: "security", name: "Seguridad", description: "Validar RLS", sort_order: 20 },
      { key: "profile", name: "Ficha", description: "Completar empresa", sort_order: 10 },
    ]
  );
  assert.deepEqual(steps, [
    {
      stepKey: "profile",
      name: "Ficha",
      description: "Completar empresa",
      status: "NOT_STARTED",
      notes: null,
      completedAt: null,
    },
    {
      stepKey: "security",
      name: "Seguridad",
      description: "Validar RLS",
      status: "BLOCKED",
      notes: "Falta aislamiento",
      completedAt: null,
    },
  ]);
});

test("miembros conservan RBAC multirol, un rol primario determinista y nunca inventan email", () => {
  const members = mapMemberItems(
    [{ id: "m1", user_id: "u1", active: true }],
    [{ id: "u1", display_name: "Ada", active: true }],
    [
      { id: "r2", code: "SUPPORT", name: "Soporte", description: null, active: true, is_system: false },
      { id: "r1", code: "ADMIN", name: "Administrador", description: null, active: true, is_system: true },
    ],
    [
      { membership_id: "m1", role_id: "r2" },
      { membership_id: "m1", role_id: "r1" },
    ]
  );
  assert.equal(members[0].roleId, "r1");
  assert.equal(members[0].roleName, "Administrador");
  assert.equal(members[0].email, null);
  assert.deepEqual(members[0].roles.map((role) => role.name), ["Administrador", "Soporte"]);
});

test("una membresía cuyo profile queda oculto por RLS falla cerrada", () => {
  assert.throws(
    () => mapMemberItems([{ id: "m1", user_id: "u1", active: true }], [], [], []),
    PlatformDataAccessError
  );
});

test("roles agregan permisos y miembros sin duplicar asignaciones", () => {
  const roles = mapRoleItems(
    [
      {
        id: "r1",
        code: "HR",
        name: "RRHH",
        description: null,
        active: true,
        is_system: true,
        base_role: "ADMIN_RRHH",
      },
    ],
    [
      { role_id: "r1", permission_code: "employees.read" },
      { role_id: "r1", permission_code: "employees.write" },
    ],
    [
      { membership_id: "m1", role_id: "r1" },
      { membership_id: "m1", role_id: "r1" },
    ]
  );
  assert.deepEqual(roles[0].permissions, ["employees.read", "employees.write"]);
  assert.equal(roles[0].baseRole, "ADMIN_RRHH");
  assert.equal(roles[0].memberCount, 1);
});

test("módulos exponen estado y resumen versionado, nunca settings crudos", () => {
  const modules = mapModuleItems({
    companyModules: [
      { module_key: "payroll", status: "PILOT", settings: { privateConfiguration: "hidden" }, settings_version: 3 },
    ],
    moduleDefinitions: [
      {
        key: "payroll",
        name: "Nómina",
        description: "Pagos",
        category: "Finanzas",
        sort_order: 20,
      },
    ],
    roles: [{ id: "r1", code: "HR", name: "RRHH", description: null, active: true, is_system: true }],
    rolePermissions: [{ role_id: "r1", permission_code: "payroll.read" }],
    permissionDefinitions: [{ code: "payroll.read", module_key: "payroll" }],
  });

  assert.deepEqual(modules, [
    {
      key: "payroll",
      name: "Nómina",
      description: "Pagos",
      category: "Finanzas",
      status: "PILOT",
      accessLabels: ["RRHH"],
      configurationSummary: "Configuración v3",
    },
  ]);
  assert.equal(JSON.stringify(modules).includes("privateConfiguration"), false);
  assert.equal(JSON.stringify(modules).includes("hidden"), false);
});

test("organigrama agrega solo asignaciones primarias vigentes y conserva huérfanos visibles", () => {
  const tree = buildOrganizationTree(
    [
      { id: "root", parent_id: null, name: "Empresa", unit_type: "COMPANY", sort_order: 0 },
      { id: "team", parent_id: "root", name: "Equipo", unit_type: "TEAM", sort_order: 10 },
      { id: "orphan", parent_id: "inactive", name: "Sin padre activo", unit_type: "OTHER", sort_order: 20 },
    ],
    [
      { employee_id: "e1", org_unit_id: "team", effective_from: "2026-01-01", effective_to: null, is_primary: true },
      { employee_id: "e1", org_unit_id: "team", effective_from: "2026-01-01", effective_to: null, is_primary: true },
      { employee_id: "e2", org_unit_id: "team", effective_from: "2027-01-01", effective_to: null, is_primary: true },
      { employee_id: "e3", org_unit_id: "team", effective_from: "2026-01-01", effective_to: null, is_primary: false },
    ],
    "2026-08-31",
    [{ org_unit_id: "team", effective_from: "2026-01-01", effective_to: null }]
  );
  assert.equal(tree.length, 2);
  assert.equal(tree[0].memberCount, 1, "la raíz agrega los integrantes de sus descendientes");
  assert.equal(tree[0].children[0].memberCount, 1);
  assert.equal(tree[0].children[0].hasLeader, true);
  assert.equal(tree[1].name, "Sin padre activo");
});

test("proyección de organigrama agrega descendientes sin transportar identificadores de empleados", () => {
  const tree = mapOrganizationProjection([
    { unit_id: "root", parent_id: null, name: "Empresa", unit_type: "COMPANY", sort_order: 0, direct_member_count: 2, has_leader: false },
    { unit_id: "area", parent_id: "root", name: "Área", unit_type: "AREA", sort_order: 10, direct_member_count: "8", has_leader: true },
  ]);
  assert.equal(tree[0].memberCount, 10);
  assert.equal(tree[0].children[0].memberCount, 8);
  assert.equal(tree[0].children[0].hasLeader, true);
  assert.equal(JSON.stringify(tree).includes("employee"), false);
});

test("invitaciones ordenan por fecha y resuelven el nombre de rol sin exponer más datos", () => {
  const items = mapInvitationItems(
    [
      {
        id: "i1",
        email: "persona@example.test",
        status: "PENDING",
        expires_at: "2026-09-07T00:00:00Z",
        created_at: "2026-08-31T00:00:00Z",
        role_id: "r1",
      },
    ],
    [{ id: "r1", code: "HR", name: "RRHH", description: null, active: true, is_system: true }]
  );
  assert.equal(items[0].roleName, "RRHH");
});

test("una invitación PENDING vencida por reloj se presenta como EXPIRED", () => {
  const [item] = mapInvitationItems(
    [{
      id: "i-old",
      email: "old@example.test",
      status: "PENDING",
      expires_at: "2020-01-01T00:00:00Z",
      created_at: "2019-12-01T00:00:00Z",
      role_id: "r1",
    }],
    [{ id: "r1", code: "HR", name: "RRHH", description: null, active: true, is_system: true }]
  );
  assert.equal(item.status, "EXPIRED");
});

test("auditoría resuelve actor sin exponer metadata ni datos sensibles", () => {
  const items = mapAuditItems(
    [{ id: 7, actor_id: "u1", action: "company.module.status_changed", target_type: "company_module", target_id: "payroll", created_at: "2026-08-31T12:00:00Z" }],
    [{ id: "u1", display_name: "Gestora Admin", active: true }]
  );
  assert.deepEqual(items, [{ id: 7, actorName: "Gestora Admin", action: "company.module.status_changed", targetType: "company_module", targetId: "payroll", createdAt: "2026-08-31T12:00:00Z" }]);
  assert.equal("metadata" in items[0], false);
});
