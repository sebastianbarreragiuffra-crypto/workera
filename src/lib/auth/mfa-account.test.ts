import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  assertSecondFactorForPrivileged,
  getMfaAccountState,
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
  currentLevel?: string | null;
  nextLevel?: string | null;
  aalError?: boolean;
}

function mockClient(options: MockOptions) {
  const client = {
    auth: {
      getClaims: async () => ({
        data: options.userId ? { claims: { sub: options.userId } } : null,
        error: options.claimsError ? { message: "claims unavailable" } : null,
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: {
            currentLevel: options.currentLevel ?? "aal1",
            nextLevel: options.nextLevel ?? "aal1",
          },
          error: options.aalError ? { message: "aal unavailable" } : null,
        }),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { client: client as SupabaseClient<Database> };
}

test("getMfaAccountState devuelve null cuando no hay sesión", async () => {
  const { client } = mockClient({ userId: null });
  assert.equal(await getMfaAccountState(client), null);
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

test("una membresía de plataforma no reactiva un profile desactivado", async () => {
  const { client } = mockClient({
    userId: "34343434-3434-3434-3434-343434343434",
    profile: { role: null, active: false },
    membership: { role: "ADMIN", active: true },
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, false);
  assert.equal(state?.isPlatformOwner, false);
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
