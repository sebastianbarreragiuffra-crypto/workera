import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { finalizePreparedPayrollClose } from "./service";

const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x47, 0x45, 0x53, 0x54, 0x4f, 0x52, 0x41]);
const HASH = createHash("sha256").update(Buffer.from(BYTES)).digest("hex");
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";

function dependencies(
  storedBytes: Uint8Array,
  rpcReplies: Array<{ data: unknown; error: { code?: string; message: string } | null } | Error> = [
    { data: SNAPSHOT_ID, error: null },
  ],
) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const replies = [...rpcReplies];
  return {
    calls,
    deps: {
      createTrustedClient: () => ({
        storage: {
          from(bucket: string) {
            assert.equal(bucket, "payroll-workbooks");
            return {
              async download(path: string) {
                calls.push({ name: "download", args: path });
                return {
                  data: { arrayBuffer: async () => storedBytes.slice().buffer },
                  error: null,
                };
              },
            };
          },
        },
        async rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          assert.ok(reply, "faltó una respuesta RPC ficticia");
          return reply;
        },
      }),
    },
  };
}

test("la frontera privilegiada confirma únicamente después de recalcular hash y tamaño", async () => {
  const { calls, deps } = dependencies(BYTES);
  const result = await finalizePreparedPayrollClose({
    operationId: "44444444-4444-4444-8444-444444444444",
    storagePath: "company/period/closed/operation.xlsx",
    expectedContentSha256: HASH,
    expectedFileSize: BYTES.byteLength,
  }, deps);

  assert.equal(result, SNAPSHOT_ID);
  assert.deepEqual(calls.map((call) => call.name), ["download", "commit_payroll_period_close"]);
  assert.deepEqual(calls[1].args, {
    p_operation_id: "44444444-4444-4444-8444-444444444444",
    p_verified_content_sha256: HASH,
    p_verified_file_size: BYTES.byteLength,
  });
});

test("metadata/hash declarados no alcanzan el commit si los bytes de Storage fueron alterados", async () => {
  const tampered = new Uint8Array([...BYTES, 0xff]);
  const { calls, deps } = dependencies(tampered);

  await assert.rejects(
    () => finalizePreparedPayrollClose({
      operationId: "44444444-4444-4444-8444-444444444444",
      storagePath: "company/period/closed/operation.xlsx",
      expectedContentSha256: HASH,
      expectedFileSize: BYTES.byteLength,
    }, deps),
    /no coincide/i
  );
  assert.deepEqual(calls.map((call) => call.name), ["download"]);
});

test("cierre reintenta una respuesta de transporte ambigua con la misma operación", async () => {
  const { calls, deps } = dependencies(BYTES, [
    { data: null, error: { code: "", message: "FetchError: connection reset" } },
    { data: SNAPSHOT_ID, error: null },
  ]);

  const result = await finalizePreparedPayrollClose({
    operationId: "44444444-4444-4444-8444-444444444444",
    storagePath: "company/period/closed/operation.xlsx",
    expectedContentSha256: HASH,
    expectedFileSize: BYTES.byteLength,
  }, deps);

  assert.equal(result, SNAPSHOT_ID);
  assert.deepEqual(calls.map((call) => call.name), [
    "download",
    "commit_payroll_period_close",
    "commit_payroll_period_close",
  ]);
  assert.deepEqual(calls[1].args, calls[2].args);
});
