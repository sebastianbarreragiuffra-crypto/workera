import assert from "node:assert/strict";
import test from "node:test";
import { commitPayrollPeriodApproval, type CommitPayrollPeriodApprovalInput } from "./approval-service";

const INPUT: CommitPayrollPeriodApprovalInput = {
  actorId: "11111111-1111-4111-8111-111111111111",
  companyId: "0a4c0000-0000-0000-0000-000000000001",
  reportingPeriodId: "22222222-2222-4222-8222-222222222222",
  expectedStatus: "IN_REVIEW",
  expectedSourceRevision: 27,
  expectedAcceptedVersionId: "33333333-3333-4333-8333-333333333333",
  readinessSha256: "a".repeat(64),
};

test("aprobación: la frontera entrega al RPC toda la evidencia estable", async () => {
  const calls: unknown[] = [];
  const approvalId = await commitPayrollPeriodApproval(INPUT, {
    createTrustedClient: () => ({
      async rpc(name, args) {
        calls.push({ name, args });
        return { data: "44444444-4444-4444-8444-444444444444", error: null };
      },
    }),
  });
  assert.equal(approvalId, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(calls, [{
    name: "approve_reporting_period_ready",
    args: {
      p_actor_id: INPUT.actorId,
      p_company_id: INPUT.companyId,
      p_reporting_period_id: INPUT.reportingPeriodId,
      p_expected_status: "IN_REVIEW",
      p_expected_source_revision: 27,
      p_expected_accepted_version_id: INPUT.expectedAcceptedVersionId,
      p_readiness_sha256: INPUT.readinessSha256,
    },
  }]);
});

test("aprobación: evidencia inválida no alcanza service_role", async () => {
  let created = false;
  await assert.rejects(
    () => commitPayrollPeriodApproval({ ...INPUT, readinessSha256: "no" }, {
      createTrustedClient: () => {
        created = true;
        throw new Error("no debe ejecutarse");
      },
    }),
    /evidencia/i,
  );
  assert.equal(created, false);
});

test("aprobación: traduce una carrera de revisión sin filtrar SQL", async () => {
  await assert.rejects(
    () => commitPayrollPeriodApproval(INPUT, {
      createTrustedClient: () => ({
        async rpc() {
          return { data: null, error: { code: "40001", message: "detalle interno" } };
        },
      }),
    }),
    /cambiaron durante la aprobación/i,
  );
});
