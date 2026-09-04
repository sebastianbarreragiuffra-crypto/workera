import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  assertSecondFactorForPrivileged,
  getMfaAccountState,
  MfaRequiredError,
  recordMfaEvent,
} from "./mfa-account";

interface MockOptions {
  userId?: string | null;
  profile?: { role: string | null; active: boolean } | null;
  membership?: { role: string; active: boolean } | null;
  insertError?: { message: string } | null;
  currentLevel?: string | null;
}

function mockClient(options: MockOptions) {
  const inserted: Record<string, unknown>[] = [];

  const client = {
    auth: {
      getClaims: async () => ({
        data: options.userId ? { claims: { sub: options.userId } } : null,
        error: null,
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: options.currentLevel ?? "aal1", nextLevel: "aal2" },
          error: null,
        }),
      },
    },
    from(table: string) {
      if (table === "mfa_events") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: options.insertError ?? null };
          },
        };
      }
      const data = table === "profiles" ? (options.profile ?? null) : (options.membership ?? null);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data, error: null }),
      };
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { client: client as SupabaseClient<Database>, inserted };
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

test("una cuenta sin privilegios no exige segundo factor", async () => {
  const { client } = mockClient({
    userId: "44444444-4444-4444-4444-444444444444",
    profile: { role: "SUPERVISOR_PRODUCTION", active: true },
    membership: null,
  });
  const state = await getMfaAccountState(client);
  assert.equal(state?.requiresMfa, false);
});

test("recordMfaEvent escribe el evento con performed_by nulo cuando es propio", async () => {
  const { client, inserted } = mockClient({ userId: "55555555-5555-5555-5555-555555555555" });
  const ok = await recordMfaEvent(client, {
    userId: "55555555-5555-5555-5555-555555555555",
    eventType: "ENROLLED",
    factorId: "factor-1",
  });
  assert.equal(ok, true);
  assert.deepEqual(inserted, [
    {
      user_id: "55555555-5555-5555-5555-555555555555",
      event_type: "ENROLLED",
      factor_id: "factor-1",
      performed_by: null,
    },
  ]);
});

test("recordMfaEvent no lanza cuando la base rechaza el registro: el factor ya está verificado", async () => {
  const { client } = mockClient({
    userId: "66666666-6666-6666-6666-666666666666",
    insertError: { message: "row-level security" },
  });
  const ok = await recordMfaEvent(client, {
    userId: "66666666-6666-6666-6666-666666666666",
    eventType: "VERIFY_SUCCESS",
  });
  assert.equal(ok, false);
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
