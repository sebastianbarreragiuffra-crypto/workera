import { test } from "node:test";
import assert from "node:assert/strict";
import { getNavItemsForRole, roleLabel } from "./nav-config";

test("SUPER_ADMIN ve navegación completa incluyendo Usuarios/Configuración", () => {
  const items = getNavItemsForRole("SUPER_ADMIN");
  assert.ok(items.some((i) => i.label === "Usuarios"));
  assert.ok(items.some((i) => i.label === "Configuración"));
  assert.ok(items.some((i) => i.href === "/empleados"));
});

test("ADMIN_RRHH ve gestión de RRHH pero NO gestión de SUPER_ADMIN", () => {
  const items = getNavItemsForRole("ADMIN_RRHH");
  assert.ok(items.some((i) => i.href === "/empleados"));
  assert.ok(!items.some((i) => i.label === "Usuarios"));
  assert.ok(!items.some((i) => i.label === "Configuración"));
});

test("SUPERVISOR_PRODUCTION ve solo su propio conjunto de items (sin Empleados/gestión)", () => {
  const items = getNavItemsForRole("SUPERVISOR_PRODUCTION");
  assert.ok(items.some((i) => i.label === "Mi equipo"));
  assert.ok(!items.some((i) => i.href === "/empleados"));
  assert.ok(!items.some((i) => i.label === "Usuarios"));
});

test("SUPERVISOR_INSTALLATION tiene exactamente el mismo conjunto de items que SUPERVISOR_PRODUCTION (mismo shape, área la aplica el backend)", () => {
  const production = getNavItemsForRole("SUPERVISOR_PRODUCTION");
  const installation = getNavItemsForRole("SUPERVISOR_INSTALLATION");
  assert.deepEqual(
    production.map((i) => i.href),
    installation.map((i) => i.href)
  );
});

test("cada rol tiene únicamente hrefs únicos (evita bug de key duplicada en la navegación)", () => {
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
