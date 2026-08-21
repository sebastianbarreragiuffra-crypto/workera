import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivilegedAdmin } from "./authorize";

/**
 * `isPrivilegedAdmin` centraliza el criterio "SUPER_ADMIN o ADMIN_RRHH" que
 * antes se repetía inline en Colaciones, Nómina, Licencias, Períodos y
 * Exportaciones (auditoría de arquitectura -- consolidación de lógica
 * duplicada, sin cambiar el criterio en sí). RLS (`is_privileged_admin()`)
 * sigue siendo el enforcement real; esto es la capa de aplicación.
 */

test("isPrivilegedAdmin: true para SUPER_ADMIN y ADMIN_RRHH", () => {
  assert.equal(isPrivilegedAdmin("SUPER_ADMIN"), true);
  assert.equal(isPrivilegedAdmin("ADMIN_RRHH"), true);
});

test("isPrivilegedAdmin: false para roles de supervisor -- nunca deben pasar este gate", () => {
  assert.equal(isPrivilegedAdmin("SUPERVISOR_PRODUCTION"), false);
  assert.equal(isPrivilegedAdmin("SUPERVISOR_INSTALLATION"), false);
});

test("isPrivilegedAdmin: false para null/undefined -- nunca autoriza por ausencia de rol", () => {
  assert.equal(isPrivilegedAdmin(null), false);
  assert.equal(isPrivilegedAdmin(undefined), false);
});
