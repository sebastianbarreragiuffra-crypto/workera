import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveCompany } from "./resolve-active-company";

function mockSupabase(rows: { company_id: string; role: string; companies: { name: string; slug: string } | null }[]) {
  return {
    from(table: string) {
      if (table !== "company_memberships") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return this;
        },
        eq() {
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("resolveActiveCompany: 0 membresías -> NONE (nunca se auto-provisiona una empresa)", async () => {
  const supabase = mockSupabase([]);
  const result = await resolveActiveCompany(supabase);
  assert.deepEqual(result, { kind: "NONE" });
});

test("resolveActiveCompany: 1 membresía -> SINGLE, con nombre/slug/rol de ESA empresa únicamente", async () => {
  const supabase = mockSupabase([{ company_id: "c1", role: "ADMIN_RRHH", companies: { name: "ARCOTEX", slug: "arcotex" } }]);
  const result = await resolveActiveCompany(supabase);
  assert.equal(result.kind, "SINGLE");
  if (result.kind === "SINGLE") {
    assert.equal(result.membership.companyId, "c1");
    assert.equal(result.membership.companySlug, "arcotex");
    assert.equal(result.membership.role, "ADMIN_RRHH");
  }
});

test("resolveActiveCompany: 2+ membresías -> MULTIPLE con exactamente esas empresas, nunca una lista global", async () => {
  const supabase = mockSupabase([
    { company_id: "c1", role: "ADMIN_RRHH", companies: { name: "ARCOTEX", slug: "arcotex" } },
    { company_id: "c2", role: "SUPERVISOR_PRODUCTION", companies: { name: "GESTORA DEMO COMPANY", slug: "demo-co" } },
  ]);
  const result = await resolveActiveCompany(supabase);
  assert.equal(result.kind, "MULTIPLE");
  if (result.kind === "MULTIPLE") {
    assert.equal(result.memberships.length, 2);
    assert.deepEqual(
      result.memberships.map((m) => m.companySlug).sort(),
      ["arcotex", "demo-co"]
    );
  }
});

test("resolveActiveCompany: fila sin company relacionada (RLS la filtró) se descarta, nunca produce una entrada rota", async () => {
  const supabase = mockSupabase([{ company_id: "c1", role: "ADMIN_RRHH", companies: null }]);
  const result = await resolveActiveCompany(supabase);
  assert.deepEqual(result, { kind: "NONE" });
});

test("resolveActiveCompany: nunca acepta un companyId como parámetro (firma de la función no lo permite)", () => {
  assert.equal(resolveActiveCompany.length, 1, "resolveActiveCompany debe tomar únicamente el cliente de sesión, nunca un company_id externo");
});
