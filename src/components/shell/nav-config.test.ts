import { test } from "node:test";
import assert from "node:assert/strict";
import { getNavItemsForRole, getNavSectionsForRole, roleLabel } from "./nav-config";

test("SUPER_ADMIN ve navegación completa incluyendo Usuarios/Configuración", () => {
  const items = getNavItemsForRole("SUPER_ADMIN");
  assert.ok(items.some((i) => i.label === "Usuarios"));
  assert.ok(items.some((i) => i.label === "Configuración"));
  assert.ok(items.some((i) => i.href === "/empleados"));
});

test("ADMIN_RRHH ve gestión de RRHH pero NO gestión de SUPER_ADMIN", () => {
  const items = getNavItemsForRole("ADMIN_RRHH");
  assert.ok(items.some((i) => i.href === "/empleados"));
  assert.ok(items.some((i) => i.label === "Colaciones" && i.href === "/colaciones"));
  assert.ok(items.some((i) => i.label === "Nómina de Pago" && i.href === "/nomina-de-pago"));
  assert.ok(!items.some((i) => i.label === "Usuarios"));
  assert.ok(!items.some((i) => i.label === "Configuración"));
});

test("SUPERVISOR_PRODUCTION/INSTALLATION nunca ven Nómina de Pago (datos financieros/bancarios, ni siquiera como 'Próximamente')", () => {
  for (const role of ["SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const sections = getNavSectionsForRole(role);
    assert.ok(!sections.flatMap((s) => s.items).some((i) => i.label === "Nómina de Pago"));
  }
});

test("SUPERVISOR_PRODUCTION ve 'Mi Equipo' (roster scopeado a su área) pero no gestión de RRHH/SUPER_ADMIN", () => {
  const items = getNavItemsForRole("SUPERVISOR_PRODUCTION");
  assert.ok(items.some((i) => i.label === "Mi Equipo" && i.href === "/empleados"));
  assert.ok(!items.some((i) => i.label === "Usuarios"));
  assert.ok(!items.some((i) => i.label === "Configuración"));
});

test("SUPERVISOR_INSTALLATION tiene exactamente el mismo conjunto de items navegables que SUPERVISOR_PRODUCTION (mismo shape, área la aplica el backend)", () => {
  const production = getNavItemsForRole("SUPERVISOR_PRODUCTION");
  const installation = getNavItemsForRole("SUPERVISOR_INSTALLATION");
  assert.deepEqual(
    production.map((i) => i.href),
    installation.map((i) => i.href)
  );
});

test("cada rol tiene únicamente hrefs únicos entre sus items navegables (evita bug de key duplicada en la navegación)", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const items = getNavItemsForRole(role);
    const hrefs = items.map((i) => i.href);
    assert.equal(new Set(hrefs).size, hrefs.length, `${role} tiene hrefs duplicados en su navegación`);
  }
});

test("roleLabel nunca devuelve un string vacío para ningún rol real", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    assert.ok(roleLabel(role).length > 0);
  }
});

test("getNavItemsForRole nunca incluye Rendiciones como navegable", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const items = getNavItemsForRole(role);
    assert.ok(!items.some((i) => i.label === "Rendiciones"));
  }
});

test("getNavSectionsForRole: Colaciones es navegable para RRHH y superadministrador", () => {
  const sections = getNavSectionsForRole("SUPER_ADMIN");
  const colaciones = sections.flatMap((s) => s.items).find((i) => i.label === "Colaciones");
  assert.deepEqual(colaciones, { label: "Colaciones", href: "/colaciones" });
});

test("getNavSectionsForRole: los módulos futuros están marcados comingSoon y sin href real", () => {
  const sections = getNavSectionsForRole("SUPER_ADMIN");
  const future = sections.flatMap((s) => s.items).filter((i) => i.label === "Rendiciones");
  assert.equal(future.length, 1);
  for (const item of future) {
    assert.equal(item.comingSoon, true);
    assert.equal(item.href, "");
  }
});

test("supervisores mantienen Colaciones como módulo próximo y sin acceso al dashboard de cobros", () => {
  const sections = getNavSectionsForRole("SUPERVISOR_PRODUCTION");
  const colaciones = sections.flatMap((s) => s.items).find((i) => i.label === "Colaciones");
  assert.deepEqual(colaciones, { label: "Colaciones", href: "", comingSoon: true });
});

test("getNavSectionsForRole: todo item SIN comingSoon tiene un href no vacío (nunca un link roto)", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const sections = getNavSectionsForRole(role);
    for (const item of sections.flatMap((s) => s.items)) {
      if (!item.comingSoon) assert.ok(item.href.length > 0, `${role}: "${item.label}" no tiene comingSoon pero su href está vacío`);
    }
  }
});
