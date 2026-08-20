import { test } from "node:test";
import assert from "node:assert/strict";
import { getNavItemsForRole, getNavSectionsForRole, roleLabel } from "./nav-config";

test("SUPER_ADMIN ve navegación completa incluyendo Usuarios/Configuración", () => {
  const items = getNavItemsForRole("SUPER_ADMIN");
  assert.ok(items.some((i) => i.label === "Usuarios"));
  assert.ok(items.some((i) => i.label === "Configuración"));
  assert.ok(items.some((i) => i.href === "/licencias"));
});

test("ADMIN_RRHH ve gestión de RRHH pero NO gestión de SUPER_ADMIN", () => {
  const items = getNavItemsForRole("ADMIN_RRHH");
  assert.ok(items.some((i) => i.href === "/licencias"));
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

test("SUPERVISOR_PRODUCTION ve 'Licencias' (directorio de su equipo + licencias, scopeado a su área) pero no gestión de RRHH/SUPER_ADMIN", () => {
  const items = getNavItemsForRole("SUPERVISOR_PRODUCTION");
  assert.ok(items.some((i) => i.label === "Licencias" && i.href === "/licencias"));
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

// ---------------------------------------------------------------------------
// Consolidación "Pendientes" -- Revisión Diaria + sus 4 filtros (Atrasos,
// Horas Extras, Clock Out Pendientes, Ausencias/Licencias) dejaron de ser
// entradas separadas del menú principal; todo vive ahora en una sola entrada
// "Pendientes" que sigue apuntando a `/revision-diaria` (los filtros se
// aplican DENTRO de esa página, no como rutas de menú distintas).
const REMOVED_FILTER_LABELS = ["Atrasos", "Horas Extras", "Clock Out Pendientes", "Ausencias / Licencias", "Revisión Diaria"];

test("ningún rol expone Atrasos/Horas Extras/Clock Out Pendientes/Ausencias/Revisión Diaria como entradas separadas de navegación (consolidadas en 'Pendientes')", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const labels = getNavItemsForRole(role).map((i) => i.label);
    for (const removed of REMOVED_FILTER_LABELS) {
      assert.ok(!labels.includes(removed), `${role} todavía expone "${removed}" como entrada separada`);
    }
  }
});

test("todos los roles tienen una única entrada 'Pendientes' que apunta a /revision-diaria", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const items = getNavItemsForRole(role).filter((i) => i.label === "Pendientes");
    assert.equal(items.length, 1, `${role} debe tener exactamente una entrada "Pendientes"`);
    assert.equal(items[0].href, "/revision-diaria");
  }
});

test("ADMIN_RRHH/SUPER_ADMIN: el orden del menú principal es exactamente Resumen Diario, Pendientes, Licencias, Colaciones, Nómina de Pago", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH"] as const) {
    const sections = getNavSectionsForRole(role);
    const mainLabels = sections[0].items.map((i) => i.label);
    assert.deepEqual(mainLabels, ["Resumen Diario", "Pendientes", "Licencias", "Colaciones", "Nómina de Pago"]);
  }
});

test("Rendiciones sigue como 'Próximamente' inmediatamente después del menú principal", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH"] as const) {
    const sections = getNavSectionsForRole(role);
    assert.equal(sections[1].heading, "Próximamente");
    assert.ok(sections[1].items.some((i) => i.label === "Rendiciones" && i.comingSoon === true));
  }
});

test("supervisores: 'Pendientes' es la segunda entrada del menú principal, justo después de Resumen Diario", () => {
  for (const role of ["SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const sections = getNavSectionsForRole(role);
    const mainLabels = sections[0].items.map((i) => i.label);
    assert.deepEqual(mainLabels[0], "Resumen Diario");
    assert.deepEqual(mainLabels[1], "Pendientes");
  }
});

test("renombrar 'Revisión Diaria' a 'Pendientes' no cambia qué rutas están disponibles por rol (mismo conjunto de hrefs navegables que antes, menos las 4 rutas de filtro que ahora viven dentro de la página)", () => {
  const rrhh = getNavItemsForRole("ADMIN_RRHH").map((i) => i.href);
  assert.ok(rrhh.includes("/revision-diaria"));
  assert.ok(rrhh.includes("/licencias"));
  assert.ok(rrhh.includes("/colaciones"));
  assert.ok(rrhh.includes("/nomina-de-pago"));

  const supervisor = getNavItemsForRole("SUPERVISOR_PRODUCTION").map((i) => i.href);
  assert.ok(supervisor.includes("/revision-diaria"));
  assert.ok(supervisor.includes("/licencias"));
  assert.ok(!supervisor.includes("/nomina-de-pago"), "los supervisores nunca deben ganar acceso a Nómina de Pago por este cambio de navegación");
  assert.ok(!supervisor.includes("/colaciones"), "Colaciones sigue siendo 'Próximamente' para supervisores, no una ruta navegable");
});

// ---------------------------------------------------------------------------
// Consolidación "Trabajadores" -> "Licencias" -- el directorio de empleados
// (antes "Empleados"/"Mi Equipo", ruta /empleados) ya no es una entrada de
// menú separada; se absorbió dentro de "Licencias" (que ahora es
// directorio + gestión de licencias en una sola página).
test("ningún rol expone 'Empleados'/'Mi Equipo' como entradas separadas de navegación (absorbidas en 'Licencias')", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const labels = getNavItemsForRole(role).map((i) => i.label);
    assert.ok(!labels.includes("Empleados"), `${role} todavía expone "Empleados" como entrada separada`);
    assert.ok(!labels.includes("Mi Equipo"), `${role} todavía expone "Mi Equipo" como entrada separada`);
  }
});

test("ningún rol navega a /empleados directamente desde el menú (la ruta sigue existiendo solo por estabilidad, vía redirect a /licencias)", () => {
  for (const role of ["SUPER_ADMIN", "ADMIN_RRHH", "SUPERVISOR_PRODUCTION", "SUPERVISOR_INSTALLATION"] as const) {
    const hrefs = getNavItemsForRole(role).map((i) => i.href);
    assert.ok(!hrefs.includes("/empleados"));
  }
});
