import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { recordMfaEvent } from "./mfa-audit";

function mockAdmin(insertError: { message: string } | null = null) {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, "mfa_events");
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return { error: insertError };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, inserted };
}

test("la bitácora MFA se escribe mediante el cliente admin server-only", async () => {
  const { client, inserted } = mockAdmin();
  const ok = await recordMfaEvent(
    {
      userId: "55555555-5555-5555-5555-555555555555",
      eventType: "ENROLLED",
      factorId: "factor-1",
    },
    { supabaseAdmin: client }
  );

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

test("un fallo de bitácora se informa sin filtrar el error del proveedor", async () => {
  const { client } = mockAdmin({ message: "detalle sensible" });
  const ok = await recordMfaEvent(
    {
      userId: "66666666-6666-6666-6666-666666666666",
      eventType: "VERIFY_SUCCESS",
    },
    { supabaseAdmin: client }
  );

  assert.equal(ok, false);
});
