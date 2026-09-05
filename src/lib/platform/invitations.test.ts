import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptCurrentUserInvitations,
  InvitationAcceptanceError,
} from "./invitations";

function client(result: { data: number | null; error: { code?: string } | null }) {
  return {
    rpc: async (name: string) => {
      assert.equal(name, "accept_my_company_invitations");
      return result;
    },
  };
}

test("distingue cero invitaciones pendientes de un fallo técnico", async () => {
  assert.equal(
    await acceptCurrentUserInvitations(client({ data: 0, error: null }) as never),
    0,
  );
});

test("devuelve el número de invitaciones aceptadas", async () => {
  assert.equal(
    await acceptCurrentUserInvitations(client({ data: 2, error: null }) as never),
    2,
  );
});

test("un error del RPC falla cerrado y no se disfraza como cero", async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      () => acceptCurrentUserInvitations(
        client({ data: null, error: { code: "XX000" } }) as never,
      ),
      InvitationAcceptanceError,
    );
  } finally {
    console.error = originalError;
  }
});
