import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationActionLimitError,
  type ApplicationMutationScope,
  applicationActionLimitMessage,
  assertApplicationActionLimit,
  consumeApplicationActionRateLimit,
} from "./action-rate-limit";

function clientResult(result: { data: unknown; error: { code?: string } | null }) {
  const calls: unknown[] = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return { maybeSingle: () => Promise.resolve(result) };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

test("envía scope y empresa al único RPC distribuido", async () => {
  const mock = clientResult({
    data: { allowed: true, request_limit: 240, remaining: 239, retry_after_seconds: 0 },
    error: null,
  });
  assert.deepEqual(await consumeApplicationActionRateLimit(mock.client, {
    scope: "expenses.workflow.mutate",
    companyId: "78000000-0000-4000-8000-000000000001",
  }), { status: "ALLOWED", requestLimit: 240, remaining: 239 });
  assert.deepEqual(mock.calls, [{
    name: "consume_application_action_rate_limit",
    args: {
      p_scope: "expenses.workflow.mutate",
      p_company_id: "78000000-0000-4000-8000-000000000001",
    },
  }]);
});

test("un scope laboral no inventa company_id en el navegador", async () => {
  const mock = clientResult({
    data: { allowed: true, request_limit: 20, remaining: 19, retry_after_seconds: 0 },
    error: null,
  });
  await consumeApplicationActionRateLimit(mock.client, { scope: "workforce.roster.manage" });
  assert.deepEqual(mock.calls[0], {
    name: "consume_application_action_rate_limit",
    args: { p_scope: "workforce.roster.manage", p_company_id: null },
  });
});

test("distingue límite, autorización y caída sin filtrar proveedor", async () => {
  const limited = clientResult({
    data: { allowed: false, request_limit: 10, remaining: 0, retry_after_seconds: 999_999 },
    error: null,
  }).client;
  const decision = await consumeApplicationActionRateLimit(limited, { scope: "workforce.sync.rerun" });
  assert.deepEqual(decision, { status: "RATE_LIMITED", requestLimit: 10, retryAfterSeconds: 86_400 });
  assert.match(applicationActionLimitMessage(decision) ?? "", /86400 segundos/);

  for (const code of ["22023", "42501", "P0001", "P0002"]) {
    const denied = clientResult({ data: null, error: { code } }).client;
    assert.deepEqual(await consumeApplicationActionRateLimit(denied, { scope: "x" as ApplicationMutationScope }), { status: "DENIED" });
  }
  const unavailable = clientResult({ data: null, error: { code: "08006" } }).client;
  assert.deepEqual(await consumeApplicationActionRateLimit(unavailable, { scope: "x" as ApplicationMutationScope }), { status: "UNAVAILABLE" });
});

test("la aserción solo deja continuar un ALLOWED", () => {
  assert.doesNotThrow(() => assertApplicationActionLimit({
    status: "ALLOWED", requestLimit: 10, remaining: 9,
  }));
  assert.throws(
    () => assertApplicationActionLimit({ status: "UNAVAILABLE" }),
    (error) => error instanceof ApplicationActionLimitError
      && error.decision.status === "UNAVAILABLE"
      && !error.message.includes("08006"),
  );
});
