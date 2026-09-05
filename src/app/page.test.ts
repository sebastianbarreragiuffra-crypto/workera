import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT_PAGE = path.join(import.meta.dirname, "page.tsx");

test("la portada falla cerrada si no puede verificar platform_memberships", () => {
  const source = readFileSync(ROOT_PAGE, "utf8");
  const lookup = source.indexOf('.from("platform_memberships")');
  const closedGuard = source.indexOf("if (platformMembershipResult.error)", lookup);
  const destination = source.indexOf("redirect(resolveWorkspaceDestination", closedGuard);

  assert.ok(lookup >= 0, "la portada debe consultar la membresía de plataforma");
  assert.ok(closedGuard > lookup, "el error de membresía debe comprobarse después de la consulta");
  assert.ok(destination > closedGuard, "el error debe cerrarse antes de escoger un workspace alternativo");
  assert.match(source.slice(closedGuard, destination), /throw new Error\(/);
  assert.doesNotMatch(source.slice(closedGuard, destination), /platformMembershipResult\.error\.message/);
});
