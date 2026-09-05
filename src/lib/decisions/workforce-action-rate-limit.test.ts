import assert from "node:assert/strict";
import test from "node:test";
import { enforceWorkforceActionRateLimit } from "./workforce-action-rate-limit";

test("el wrapper laboral nunca acepta company_id desde el llamador", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return {
        maybeSingle: () => Promise.resolve({
          data: { allowed: true, request_limit: 240, remaining: 239, retry_after_seconds: 0 },
          error: null,
        }),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await enforceWorkforceActionRateLimit(client as any, "workforce.review.mutate");
  assert.deepEqual(calls, [{
    name: "consume_application_action_rate_limit",
    args: { p_scope: "workforce.review.mutate", p_company_id: null },
  }]);
});
