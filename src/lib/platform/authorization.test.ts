import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  PlatformAuthorizationError,
  assertPlatformManager,
  getPlatformSessionFromClient,
  isPlatformManagerRole,
  requirePlatformSessionFromClient,
  type PlatformRole,
} from "./authorization";

interface MockOptions {
  userId?: string;
  authError?: boolean;
  membership?: { user_id: string; role: PlatformRole | string; active: boolean } | null;
  membershipError?: boolean;
}

function createMockClient(options: MockOptions) {
  const events: string[] = [];
  const query = {
    select(columns: string) {
      events.push(`select:${columns}`);
      return this;
    },
    eq(column: string, value: unknown) {
      events.push(`eq:${column}:${String(value)}`);
      return this;
    },
    maybeSingle() {
      return Promise.resolve({
        data: options.membership ?? null,
        error: options.membershipError ? { message: "detalle interno que no debe filtrarse" } : null,
      });
    },
  };
  const client = {
    auth: {
      getClaims: async () => ({
        data: options.userId ? { claims: { sub: options.userId } } : { claims: {} },
        error: options.authError ? { message: "jwt inválido" } : null,
      }),
    },
    from(table: string) {
      events.push(`from:${table}`);
      return query;
    },
  } as unknown as SupabaseClient<Database>;
  return { client, events };
}

test("getPlatformSession usa claims reales y filtra la membresía activa del mismo usuario", async () => {
  const { client, events } = createMockClient({
    userId: "user-1",
    membership: { user_id: "user-1", role: "OWNER", active: true },
  });

  assert.deepEqual(await getPlatformSessionFromClient(client), {
    userId: "user-1",
    role: "OWNER",
    canManage: true,
  });
  assert.deepEqual(events, [
    "from:platform_memberships",
    "select:user_id, role, active",
    "eq:user_id:user-1",
    "eq:active:true",
  ]);
});

test("sesión inválida falla cerrada sin consultar platform_memberships", async () => {
  const { client, events } = createMockClient({ authError: true });
  assert.equal(await getPlatformSessionFromClient(client), null);
  assert.deepEqual(events, []);
});

test("membresía ausente, inactiva o con rol inesperado nunca autoriza", async () => {
  for (const membership of [
    null,
    { user_id: "user-1", role: "VIEWER", active: false },
    { user_id: "user-1", role: "UNKNOWN", active: true },
    { user_id: "otro", role: "ADMIN", active: true },
  ]) {
    const { client } = createMockClient({ userId: "user-1", membership });
    assert.equal(await getPlatformSessionFromClient(client), null);
  }
});

test("errores de RLS/consulta producen un error claro sin filtrar el detalle interno", async () => {
  const { client } = createMockClient({ userId: "user-1", membershipError: true });
  await assert.rejects(
    () => getPlatformSessionFromClient(client),
    (error: unknown) => {
      assert.ok(error instanceof PlatformAuthorizationError);
      assert.match(error.message, /verificar el acceso/);
      assert.doesNotMatch(error.message, /detalle interno/);
      return true;
    }
  );
});

test("OWNER/ADMIN gestionan; SUPPORT/VIEWER conservan acceso de solo lectura", () => {
  assert.equal(isPlatformManagerRole("OWNER"), true);
  assert.equal(isPlatformManagerRole("ADMIN"), true);
  assert.equal(isPlatformManagerRole("SUPPORT"), false);
  assert.equal(isPlatformManagerRole("VIEWER"), false);

  assert.equal(assertPlatformManager({ userId: "1", role: "ADMIN", canManage: true }).role, "ADMIN");
  assert.throws(
    () => assertPlatformManager({ userId: "2", role: "SUPPORT", canManage: false }),
    PlatformAuthorizationError
  );
});

test("requirePlatformSessionFromClient rechaza una identidad autenticada sin membresía de plataforma", async () => {
  const { client } = createMockClient({ userId: "user-1", membership: null });
  await assert.rejects(() => requirePlatformSessionFromClient(client), PlatformAuthorizationError);
});
