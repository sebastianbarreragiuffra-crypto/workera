import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isMfaAllowedPath,
  postLoginDestination,
  MFA_ALLOWED_PATHS,
} from "./mfa";

test("las rutas alcanzables en aal1 son exactamente las declaradas", () => {
  for (const allowed of MFA_ALLOWED_PATHS) {
    assert.equal(isMfaAllowedPath(allowed), true, `${allowed} debería ser alcanzable en aal1`);
  }
  assert.equal(isMfaAllowedPath("/seguridad/mfa"), true);
  assert.equal(isMfaAllowedPath("/login/mfa"), true);
});

test("/logout no está en la lista: no existe esa ruta, cerrar sesión es una Server Action", () => {
  assert.equal(isMfaAllowedPath("/logout"), false);
  assert.equal(MFA_ALLOWED_PATHS.includes("/logout"), false);
});

test("las dos pantallas MFA ofrecen cerrar sesión, que es la salida real en aal1", () => {
  const pages = [
    path.join(import.meta.dirname, "..", "..", "app", "seguridad", "mfa", "page.tsx"),
    path.join(import.meta.dirname, "..", "..", "app", "login", "mfa", "page.tsx"),
  ];

  for (const page of pages) {
    const source = readFileSync(page, "utf8");
    assert.match(
      source,
      /<MfaSignOut\s*\/>/,
      `${page} debe ofrecer cerrar sesión: con el bloqueo activo el gate saca a esta cuenta de toda otra pantalla que muestre el botón`
    );
  }
});

test("la coincidencia es exacta: ni prefijos ni subrutas heredan el permiso", () => {
  assert.equal(isMfaAllowedPath("/"), false);
  assert.equal(isMfaAllowedPath("/dashboard"), false);
  assert.equal(isMfaAllowedPath("/plataforma"), false);
  assert.equal(isMfaAllowedPath("/login-de-mentira"), false);
  assert.equal(isMfaAllowedPath("/seguridad"), false);
  assert.equal(isMfaAllowedPath("/seguridad/mfa/otra"), false);
});

test("con un factor verificado y sesión en aal1, el login manda al desafío", () => {
  assert.equal(
    postLoginDestination({ currentLevel: "aal1", nextLevel: "aal2", requiresMfa: true, hasVerifiedFactor: true }),
    "/login/mfa"
  );
});

test("una cuenta que exige MFA y no inscribió nada va a la pantalla de inscripción", () => {
  assert.equal(
    postLoginDestination({ currentLevel: "aal1", nextLevel: "aal1", requiresMfa: true, hasVerifiedFactor: false }),
    "/seguridad/mfa"
  );
});

test("una sesión ya en aal2 no vuelve a pasar por el desafío", () => {
  assert.equal(
    postLoginDestination({ currentLevel: "aal2", nextLevel: "aal2", requiresMfa: true, hasVerifiedFactor: true }),
    "/"
  );
});

test("una cuenta sin obligación de MFA y sin factores entra directo", () => {
  assert.equal(
    postLoginDestination({ currentLevel: "aal1", nextLevel: "aal1", requiresMfa: false, hasVerifiedFactor: false }),
    "/"
  );
});

test("una cuenta sin obligación pero con factor inscrito igual pasa por el desafío", () => {
  assert.equal(
    postLoginDestination({ currentLevel: "aal1", nextLevel: "aal2", requiresMfa: false, hasVerifiedFactor: true }),
    "/login/mfa"
  );
});

test("niveles nulos no mandan a ninguna pantalla de MFA", () => {
  assert.equal(
    postLoginDestination({ currentLevel: null, nextLevel: null, requiresMfa: false, hasVerifiedFactor: false }),
    "/"
  );
});
