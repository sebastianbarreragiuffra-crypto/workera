import assert from "node:assert/strict";
import test from "node:test";
import { resolvePayrollCompanyRole } from "./payroll-company-role";

function client(responses: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "has_company_app_role");
      calls.push(args);
      return responses[String(args.p_role)] ?? { data: false, error: null };
    },
  };
}

test("pre-nómina: usa el rol del tenant y no profiles.role", async () => {
  const mock = client({
    ADMIN_RRHH: { data: false, error: null },
    SUPER_ADMIN: { data: true, error: null },
  });
  assert.equal(
    await resolvePayrollCompanyRole(mock, "company-a", ["ADMIN_RRHH", "SUPER_ADMIN"]),
    "SUPER_ADMIN",
  );
  assert.deepEqual(mock.calls, [
    { p_company_id: "company-a", p_role: "ADMIN_RRHH" },
    { p_company_id: "company-a", p_role: "SUPER_ADMIN" },
  ]);
});

test("pre-nómina: falla cerrado ante rol ausente o error RPC", async () => {
  assert.equal(
    await resolvePayrollCompanyRole(client({ ADMIN_RRHH: { data: false, error: null } }), "company-a", ["ADMIN_RRHH"]),
    null,
  );
  assert.equal(
    await resolvePayrollCompanyRole(client({ ADMIN_RRHH: { data: null, error: { message: "db" } } }), "company-a", ["ADMIN_RRHH"]),
    null,
  );
});
