import { test } from "node:test";
import assert from "node:assert/strict";
import { getExpenseCompanyContextFromClient, listExpenseCompaniesFromClient } from "./access";

/**
 * Mock mínimo del cliente Supabase, en la misma línea que el de
 * `business-rules/schedule.test.ts`: cada tabla resuelve a una respuesta
 * fija y se registra qué se consultó, para poder afirmar también lo que NO
 * se consulta (un slug inválido no debe tocar la red, una persona sin
 * empresas no debe consultar módulos).
 *
 * El builder es "thenable" porque access.ts espera la consulta directamente
 * (`await supabase.from(...).select(...).eq(...)`) además de usar
 * `.maybeSingle()` para el perfil.
 */
function createMockSupabase(options: {
  claimsSub?: string | null;
  tables?: Record<string, { data: unknown; error: unknown }>;
  grantedPermissions?: string[];
  permissionError?: boolean;
}) {
  const queried: string[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const granted = new Set(options.grantedPermissions ?? []);

  function builderFor(table: string) {
    const response = options.tables?.[table] ?? { data: [], error: null };
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      maybeSingle: async () => response,
      then: (
        resolve: (value: { data: unknown; error: unknown }) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(response).then(resolve, reject),
    };
    return builder;
  }

  return {
    client: {
      auth: {
        getClaims: async () =>
          options.claimsSub === null
            ? { data: null, error: { message: "sin sesión" } }
            : { data: { claims: { sub: options.claimsSub ?? "user-1" } }, error: null },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from(table: string): any {
        queried.push(table);
        return builderFor(table);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        if (options.permissionError) return { data: null, error: { message: "falló" } };
        return { data: granted.has(String(args.p_permission_code)), error: null };
      },
    },
    queried,
    rpcCalls,
  };
}

const membershipRow = (company: {
  id: string;
  name: string;
  slug: string;
  active?: boolean;
  status?: string;
}) => ({
  company_id: company.id,
  companies: {
    id: company.id,
    name: company.name,
    slug: company.slug,
    active: company.active ?? true,
    status: company.status ?? "ACTIVE",
  },
});

// ---------------------------------------------------------------------------
// listExpenseCompaniesFromClient

test("solo devuelve empresas activas con el módulo Rendiciones habilitado", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: {
        data: [
          membershipRow({ id: "c-activa", name: "Zeta", slug: "zeta" }),
          membershipRow({ id: "c-inactiva", name: "Alfa", slug: "alfa", active: false }),
          membershipRow({ id: "c-sin-modulo", name: "Beta", slug: "beta" }),
        ],
        error: null,
      },
      company_modules: {
        data: [{ company_id: "c-activa", status: "PILOT" }],
        error: null,
      },
    },
  });

  const companies = await listExpenseCompaniesFromClient(mock.client as never, "user-1");
  assert.deepEqual(
    companies.map((company) => company.slug),
    ["zeta"],
    "la empresa inactiva y la que no tiene el módulo quedan fuera"
  );
  assert.equal(companies[0].moduleStatus, "PILOT", "PILOT cuenta como habilitado, igual que ENABLED");
});

test("ordena por nombre con locale español", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: {
        data: [
          membershipRow({ id: "c1", name: "Zeta", slug: "zeta" }),
          membershipRow({ id: "c2", name: "Ñandú", slug: "nandu" }),
          membershipRow({ id: "c3", name: "Alfa", slug: "alfa" }),
        ],
        error: null,
      },
      company_modules: {
        data: [
          { company_id: "c1", status: "ENABLED" },
          { company_id: "c2", status: "ENABLED" },
          { company_id: "c3", status: "ENABLED" },
        ],
        error: null,
      },
    },
  });

  const companies = await listExpenseCompaniesFromClient(mock.client as never, "user-1");
  assert.deepEqual(companies.map((company) => company.name), ["Alfa", "Ñandú", "Zeta"]);
});

test("sin membresías no consulta el catálogo de módulos", async () => {
  const mock = createMockSupabase({ tables: { company_memberships: { data: [], error: null } } });
  assert.deepEqual(await listExpenseCompaniesFromClient(mock.client as never, "user-1"), []);
  assert.deepEqual(mock.queried, ["company_memberships"], "se corta antes de la segunda consulta");
});

test("desempaqueta el embed de PostgREST venga como objeto o como arreglo", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: {
        data: [
          { company_id: "c1", companies: { id: "c1", name: "Objeto", slug: "objeto", active: true, status: "ACTIVE" } },
          { company_id: "c2", companies: [{ id: "c2", name: "Arreglo", slug: "arreglo", active: true, status: "ACTIVE" }] },
        ],
        error: null,
      },
      company_modules: {
        data: [
          { company_id: "c1", status: "ENABLED" },
          { company_id: "c2", status: "ENABLED" },
        ],
        error: null,
      },
    },
  });

  const companies = await listExpenseCompaniesFromClient(mock.client as never, "user-1");
  assert.deepEqual(companies.map((company) => company.slug), ["arreglo", "objeto"]);
});

test("un fallo de consulta se propaga como error, nunca como lista vacía", async () => {
  const membershipFailure = createMockSupabase({
    tables: { company_memberships: { data: null, error: { message: "boom" } } },
  });
  await assert.rejects(
    () => listExpenseCompaniesFromClient(membershipFailure.client as never, "user-1"),
    /No se pudieron verificar tus empresas/,
    "una caída de membresías no puede confundirse con 'no tiene empresas'"
  );

  const moduleFailure = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "c1", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: null, error: { message: "boom" } },
    },
  });
  await assert.rejects(
    () => listExpenseCompaniesFromClient(moduleFailure.client as never, "user-1"),
    /No se pudo verificar el módulo Rendiciones/
  );
});

// ---------------------------------------------------------------------------
// getExpenseCompanyContextFromClient

test("un slug con formato inválido devuelve null sin consultar nada", async () => {
  for (const slug of ["../../etc", "MAYÚSCULAS con espacios", "-guion-inicial", "doble--guion", ""]) {
    const mock = createMockSupabase({});
    assert.equal(await getExpenseCompanyContextFromClient(mock.client as never, slug), null, `slug: ${slug}`);
    assert.deepEqual(mock.queried, [], `slug inválido (${slug}) no debe tocar la base`);
    assert.deepEqual(mock.rpcCalls, [], `slug inválido (${slug}) no debe evaluar permisos`);
  }
});

test("normaliza el slug antes de resolver la empresa", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "c1", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: [{ company_id: "c1", status: "ENABLED" }], error: null },
      profiles: { data: { display_name: "Ana" }, error: null },
    },
    grantedPermissions: ["expenses.submit"],
  });

  const context = await getExpenseCompanyContextFromClient(mock.client as never, "  ALFA  ");
  assert.equal(context?.slug, "alfa", "trim + minúsculas");
});

test("sin sesión válida devuelve null", async () => {
  const mock = createMockSupabase({ claimsSub: null });
  assert.equal(await getExpenseCompanyContextFromClient(mock.client as never, "alfa"), null);
});

test("una empresa fuera de las propias devuelve null", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "c1", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: [{ company_id: "c1", status: "ENABLED" }], error: null },
    },
  });
  assert.equal(await getExpenseCompanyContextFromClient(mock.client as never, "empresa-ajena"), null);
});

test("un perfil inactivo o inexistente devuelve null aunque la membresía exista", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "c1", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: [{ company_id: "c1", status: "ENABLED" }], error: null },
      profiles: { data: null, error: null },
    },
    grantedPermissions: ["expenses.manage"],
  });
  assert.equal(await getExpenseCompanyContextFromClient(mock.client as never, "alfa"), null);
});

test("expenses.manage absorbe submit y reconcile, pero NO read/approve/configure", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "c1", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: [{ company_id: "c1", status: "ENABLED" }], error: null },
      profiles: { data: { display_name: "Ana" }, error: null },
    },
    grantedPermissions: ["expenses.manage"],
  });

  const context = await getExpenseCompanyContextFromClient(mock.client as never, "alfa");
  assert.ok(context);
  assert.equal(context.canManage, true);
  assert.equal(context.canSubmit, true, "canSubmit hereda de manage");
  assert.equal(context.canReconcile, true, "canReconcile hereda de manage");
  // Estos tres NO heredan: cada pantalla que los usa escribe el
  // `|| canManage` en su propio gate (ver ExpenseShell y las páginas). Este
  // test fija esa asimetría a propósito -- si alguien la "empareja" en un
  // solo lado, cambia en silencio quién ve qué.
  assert.equal(context.canReadAll, false, "canReadAll no hereda de manage");
  assert.equal(context.canApprove, false, "canApprove no hereda de manage");
  assert.equal(context.canConfigure, false, "canConfigure no hereda de manage");
});

test("cada permiso se consulta contra la empresa resuelta, no contra el slug de la URL", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "company-uuid", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: [{ company_id: "company-uuid", status: "ENABLED" }], error: null },
      profiles: { data: { display_name: "Ana" }, error: null },
    },
    grantedPermissions: ["expenses.submit", "expenses.approve"],
  });

  const context = await getExpenseCompanyContextFromClient(mock.client as never, "alfa");
  assert.equal(context?.canApprove, true);
  assert.equal(context?.canConfigure, false);
  assert.deepEqual(
    mock.rpcCalls.map((call) => call.name),
    Array(6).fill("has_company_permission"),
    "los 6 permisos se resuelven en la base, no en el cliente"
  );
  assert.ok(
    mock.rpcCalls.every((call) => call.args.p_company_id === "company-uuid"),
    "siempre contra el id resuelto de la empresa"
  );
});

test("si la evaluación de permisos falla, el error se propaga (nunca se asume 'sin permiso')", async () => {
  const mock = createMockSupabase({
    tables: {
      company_memberships: { data: [membershipRow({ id: "c1", name: "Alfa", slug: "alfa" })], error: null },
      company_modules: { data: [{ company_id: "c1", status: "ENABLED" }], error: null },
      profiles: { data: { display_name: "Ana" }, error: null },
    },
    permissionError: true,
  });
  await assert.rejects(
    () => getExpenseCompanyContextFromClient(mock.client as never, "alfa"),
    /No se pudieron verificar tus permisos/
  );
});
