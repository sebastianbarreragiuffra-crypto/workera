import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  assertSecondFactorForPrivileged,
  getMfaAccountState,
  getVerifiedCurrentAal,
  getVerifiedMfaSessionState,
  MfaRequiredError,
  MfaStateUnavailableError,
  resolvePostLoginDestination,
} from "./mfa-account";

interface MockOptions {
  userId?: string | null;
  claimsError?: boolean;
  profile?: { role: string | null; active: boolean } | null;
  membership?: { role: string; active: boolean } | null;
  profileError?: boolean;
  membershipError?: boolean;
  requiresMfa?: boolean;
  mfaRequirementError?: boolean;
  currentLevel?: string | null;
  nextLevel?: string | null;
  aalError?: boolean;
  factorsError?: boolean;
}

function mockClient(options: MockOptions) {
  const defaultRequiresMfa = Boolean(
    options.profile?.active
    && (
      options.profile.role === "SUPER_ADMIN"
      || options.profile.role === "ADMIN_RRHH"
      || (options.membership?.active && ["OWNER", "ADMIN"].includes(options.membership.role))
    )
  );
  const client = {
    auth: {
      getClaims: async () => ({
        data: options.userId
          ? { claims: { sub: options.userId, aal: options.currentLevel ?? "aal1" } }
          : null,
        error: options.claimsError || options.aalError ? { message: "claims unavailable" } : null,
      }),
      mfa: {
        listFactors: async () => {
          const verified = options.nextLevel === "aal2"
            ? [{
                id: "12121212-1212-4212-8212-121212121212",
                factor_type: "totp",
                status: "verified",
                created_at: "2026-09-05T00:00:00.000Z",
                updated_at: "2026-09-05T00:00:00.000Z",
              }]
            : [];
          return {
            data: options.factorsError
              ? null
              : { all: verified, totp: verified, phone: [], webauthn: [] },
            error: options.factorsError ? { message: "factors unavailable" } : null,
          };
        },
      },
    },
    from(table: string) {
      const data = table === "profiles" ? (options.profile ?? null) : (options.membership ?? null);
      const queryError =
        table === "profiles" ? options.profileError === true : options.membershipError === true;
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data,
          error: queryError ? { message: "lookup unavailable" } : null,
        }),
      };
      return chain;
    },
    rpc: async (name: string) => {
      if (name !== "session_requires_mfa") throw new Error(`unexpected rpc ${name}`);
      return {
        data: options.mfaRequirementError ? null : (options.requiresMfa ?? defaultRequiresMfa),
        error: options.mfaRequirementError ? { message: "requirement unavailable" } : null,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { client: client as SupabaseClient<Database> };
}

test("getMfaAccountState devuelve null cuando no hay sesión", async () => {
  const { client } = mockClient({ userId: null });
  assert.equal(await getMfaAccountState(client), null);
});

test("el nivel MFA se deriva de claims verificados y factores leídos desde Auth", async () => {
  const { client } = mockClient({
    userId: "10101010-1010-4010-8010-101010101010",
    currentLevel: "aal1",
    nextLevel: "aal2",
  });

  assert.equal(await getVerifiedCurrentAal(client), "aal1");
  const state = await getVerifiedMfaSessionState(client);
  assert.equal(state?.currentLevel, "aal1");
  assert.equal(state?.nextLevel, "aal2");
  assert.equal(state?.factors.totp.length, 1);
});

test("el estado MFA falla cerrado si Auth no puede verificar los factores", async () => {
  const { client } = mockClient({
    userId: "11111111-1010-4010-8010-101010101010",
    currentLevel: "aal1",
    factorsError: true,
  });

  assert.equal(await getVerifiedMfaSessionState(client), null);
});

test("un ADMIN_RRHH activo exige segundo factor y no es OWNER de plataforma", async () => {
  const { client } = mockClient({
    userId: "11111111-1111-1111-1111-111111111111",
    profile: { role: "ADMIN_RRHH", active: true },
    membership: null,
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, true);
  assert.equal(state?.isPlatformOwner, false);
});

test("el OWNER de plataforma exige segundo factor aunque no tenga rol de workspace", async () => {
  const { client } = mockClient({
    userId: "22222222-2222-2222-2222-222222222222",
    profile: { role: null, active: true },
    membership: { role: "OWNER", active: true },
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, true);
  assert.equal(state?.isPlatformOwner, true);
});

test("un ADMIN de plataforma exige segundo factor pero no recibe el flujo de doble factor del OWNER", async () => {
  const { client } = mockClient({
    userId: "33333333-3333-3333-3333-333333333333",
    profile: { role: null, active: true },
    membership: { role: "ADMIN", active: true },
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, true);
  assert.equal(state?.isPlatformOwner, false);
});

test("un rol RBAC tenant puro queda fuera hasta que todos sus RPC exijan AAL2", async () => {
  const { client } = mockClient({
    userId: "30303030-3030-4030-8030-303030303030",
    profile: { role: null, active: true },
    membership: null,
    requiresMfa: false,
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, false);
  assert.equal(state?.isPlatformOwner, false);
});

test("un profile desactivado bloquea el post-login aunque conserve una membresía", async () => {
  const { client } = mockClient({
    userId: "34343434-3434-3434-3434-343434343434",
    profile: { role: null, active: false },
    membership: { role: "ADMIN", active: true },
  });
  await assert.rejects(() => getMfaAccountState(client), MfaStateUnavailableError);
});

test("una cuenta sin privilegios no exige segundo factor", async () => {
  const { client } = mockClient({
    userId: "44444444-4444-4444-4444-444444444444",
    profile: { role: "SUPERVISOR_PRODUCTION", active: true },
    membership: null,
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, false);
});

test("matriz MFA laboral: superadministración y RRHH exigen AAL2; supervisores y trabajador no", async () => {
  const cases = [
    { role: "SUPER_ADMIN", requiresMfa: true },
    { role: "ADMIN_RRHH", requiresMfa: true },
    { role: "SUPERVISOR_PRODUCTION", requiresMfa: false },
    { role: "SUPERVISOR_INSTALLATION", requiresMfa: false },
    { role: "WORKER", requiresMfa: false },
  ] as const;

  for (const scenario of cases) {
    const { client } = mockClient({
      userId: `synthetic-${scenario.role.toLowerCase()}`,
      profile: { role: scenario.role, active: true },
    });
    assert.equal(
      (await getMfaAccountState(client))?.requiresMfa,
      scenario.requiresMfa,
      scenario.role,
    );
  }
});

test("un fallo leyendo profile bloquea en lugar de asumir que MFA no aplica", async () => {
  const { client } = mockClient({
    userId: "66666666-6666-6666-6666-666666666666",
    profileError: true,
  });
  await assert.rejects(() => getMfaAccountState(client), MfaStateUnavailableError);
});

test("un fallo leyendo la membresía de plataforma también bloquea", async () => {
  const { client } = mockClient({
    userId: "67676767-6767-6767-6767-676767676767",
    profile: { role: "SUPER_ADMIN", active: true },
    membershipError: true,
  });
  await assert.rejects(() => getMfaAccountState(client), MfaStateUnavailableError);
});

test("un fallo de la autoridad SQL de MFA bloquea en lugar de asumir aal1 permitido", async () => {
  const { client } = mockClient({
    userId: "68686868-6868-4868-8868-686868686868",
    profile: { role: null, active: true },
    mfaRequirementError: true,
  });
  await assert.rejects(() => getMfaAccountState(client), MfaStateUnavailableError);
});

async function withEnforcement<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MFA_ENFORCEMENT_ENABLED;
  if (value === undefined) delete process.env.MFA_ENFORCEMENT_ENABLED;
  else process.env.MFA_ENFORCEMENT_ENABLED = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MFA_ENFORCEMENT_ENABLED;
    else process.env.MFA_ENFORCEMENT_ENABLED = previous;
  }
}

test("con el flag apagado, nómina no exige segundo factor a nadie", async () => {
  const { client } = mockClient({
    userId: "77777777-7777-7777-7777-777777777777",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal1",
  });
  await withEnforcement("false", async () => {
    await assertSecondFactorForPrivileged(client);
  });
});

test("con el flag activo, una cuenta privilegiada en aal1 no puede generar nómina", async () => {
  const { client } = mockClient({
    userId: "88888888-8888-8888-8888-888888888888",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal1",
  });
  await withEnforcement("true", async () => {
    await assert.rejects(() => assertSecondFactorForPrivileged(client), MfaRequiredError);
  });
});

test("con enforcement activo, una sesión ausente falla cerrada", async () => {
  const { client } = mockClient({ userId: null });
  await withEnforcement("true", async () => {
    await assert.rejects(() => assertSecondFactorForPrivileged(client), MfaRequiredError);
  });
});

test("con enforcement activo, un error al leer AAL falla cerrado", async () => {
  const { client } = mockClient({
    userId: "89898989-8989-8989-8989-898989898989",
    profile: { role: "ADMIN_RRHH", active: true },
    aalError: true,
  });
  await withEnforcement("true", async () => {
    await assert.rejects(() => assertSecondFactorForPrivileged(client), MfaRequiredError);
  });
});

test("la misma cuenta pasa cuando la sesión llegó a aal2", async () => {
  const { client } = mockClient({
    userId: "99999999-9999-9999-9999-999999999999",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal2",
  });
  await withEnforcement("true", async () => {
    await assertSecondFactorForPrivileged(client);
  });
});

test("una cuenta fuera del conjunto MFA no se ve afectada por la guarda de nómina", async () => {
  const { client } = mockClient({
    userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    profile: { role: "SUPERVISOR_PRODUCTION", active: true },
    currentLevel: "aal1",
  });
  await withEnforcement("true", async () => {
    await assertSecondFactorForPrivileged(client);
  });
});

test("con el flag apagado, una cuenta privilegiada sin factor entra directo", async () => {
  const { client } = mockClient({
    userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal1",
    nextLevel: "aal1",
  });
  await withEnforcement("false", async () => {
    assert.equal(await resolvePostLoginDestination(client), "/");
  });
});

test("el desafío de quien ya inscribió no depende del flag", async () => {
  const { client } = mockClient({
    userId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal1",
    nextLevel: "aal2",
  });
  await withEnforcement("false", async () => {
    assert.equal(await resolvePostLoginDestination(client), "/login/mfa");
  });
});

test("con el flag activo, una cuenta privilegiada sin factor va a inscribirse", async () => {
  const { client } = mockClient({
    userId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal1",
    nextLevel: "aal1",
  });
  await withEnforcement("true", async () => {
    assert.equal(await resolvePostLoginDestination(client), "/seguridad/mfa");
  });
});

test("una sesión que ya llegó a aal2 entra sin desvíos", async () => {
  const { client } = mockClient({
    userId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    profile: { role: "ADMIN_RRHH", active: true },
    currentLevel: "aal2",
    nextLevel: "aal2",
  });
  await withEnforcement("true", async () => {
    assert.equal(await resolvePostLoginDestination(client), "/");
  });
});

test("una cuenta sin privilegios entra directo con el flag encendido", async () => {
  const { client } = mockClient({
    userId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    profile: { role: "SUPERVISOR_PRODUCTION", active: true },
    currentLevel: "aal1",
    nextLevel: "aal1",
  });
  await withEnforcement("true", async () => {
    assert.equal(await resolvePostLoginDestination(client), "/");
  });
});
