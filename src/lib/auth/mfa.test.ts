import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profileRequiresMfa,
  isMfaAllowedPath,
  postLoginDestination,
  MFA_ALLOWED_PATHS,
  type MfaAccount,
} from "./mfa";

function account(overrides: Partial<MfaAccount> = {}): MfaAccount {
  return { profile: null, platformMembership: null, ...overrides };
}

test("un ADMIN_RRHH activo del workspace exige segundo factor", () => {
  assert.equal(profileRequiresMfa(account({ profile: { role: "ADMIN_RRHH", active: true } })), true);
});

test("un SUPER_ADMIN activo del workspace exige segundo factor", () => {
  assert.equal(profileRequiresMfa(account({ profile: { role: "SUPER_ADMIN", active: true } })), true);
});

test("el OWNER de plataforma exige segundo factor aunque no tenga rol de workspace", () => {
  assert.equal(
    profileRequiresMfa(account({
      profile: { role: null, active: true },
      platformMembership: { role: "OWNER", active: true },
    })),
    true
  );
});

test("un ADMIN de plataforma exige segundo factor", () => {
  assert.equal(
    profileRequiresMfa(account({
      profile: { role: null, active: true },
      platformMembership: { role: "ADMIN", active: true },
    })),
    true
  );
});

test("SUPPORT y VIEWER de plataforma todavía no entran al conjunto MFA", () => {
  assert.equal(profileRequiresMfa(account({ platformMembership: { role: "SUPPORT", active: true } })), false);
  assert.equal(profileRequiresMfa(account({ platformMembership: { role: "VIEWER", active: true } })), false);
});

test("los supervisores quedan fuera, igual que en account_requires_mfa", () => {
  assert.equal(
    profileRequiresMfa(account({ profile: { role: "SUPERVISOR_PRODUCTION", active: true } })),
    false
  );
  assert.equal(
    profileRequiresMfa(account({ profile: { role: "SUPERVISOR_INSTALLATION", active: true } })),
    false
  );
});

test("una cuenta sin rol de workspace ni membresía de plataforma no exige nada", () => {
  assert.equal(profileRequiresMfa(account({ profile: { role: null, active: true } })), false);
  assert.equal(profileRequiresMfa(account()), false);
});

test("una cuenta privilegiada desactivada no exige segundo factor", () => {
  assert.equal(profileRequiresMfa(account({ profile: { role: "ADMIN_RRHH", active: false } })), false);
});

test("una membresía de plataforma inactiva no exige segundo factor", () => {
  assert.equal(
    profileRequiresMfa(account({
      profile: { role: null, active: true },
      platformMembership: { role: "OWNER", active: false },
    })),
    false
  );
});

test("una membresía de plataforma activa no reactiva un profile desactivado", () => {
  assert.equal(
    profileRequiresMfa(account({
      profile: { role: null, active: false },
      platformMembership: { role: "OWNER", active: true },
    })),
    false
  );
});

test("basta con uno de los dos lados: rol de workspace inactivo pero plataforma activa", () => {
  assert.equal(
    profileRequiresMfa(
      account({
        profile: { role: "SUPERVISOR_PRODUCTION", active: true },
        platformMembership: { role: "OWNER", active: true },
      })
    ),
    true
  );
});

test("las rutas alcanzables en aal1 son exactamente las declaradas", () => {
  for (const path of MFA_ALLOWED_PATHS) {
    assert.equal(isMfaAllowedPath(path), true, `${path} debería ser alcanzable en aal1`);
  }
  assert.equal(isMfaAllowedPath("/seguridad/mfa"), true);
  assert.equal(isMfaAllowedPath("/login/mfa"), true);
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
