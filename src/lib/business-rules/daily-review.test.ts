import { test } from "node:test";
import assert from "node:assert/strict";
import { getDailyReview, DailyReviewAuthorizationError } from "./daily-review";

function createMockSupabase() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(): any {
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        in() {
          return builder;
        },
        single: async () => ({ data: { id: "grp-1" }, error: null }),
        then(onResolve: (r: { data: unknown; error: unknown }) => void) {
          onResolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
}

test("getDailyReview: SUPERVISOR_PRODUCTION pidiendo INSTALLATION -> DENIED (scoping aplicado en el servicio, no solo RLS)", async () => {
  await assert.rejects(
    () => getDailyReview(createMockSupabase() as never, "SUPERVISOR_PRODUCTION", "INSTALLATION", "2026-08-17"),
    DailyReviewAuthorizationError
  );
});

test("getDailyReview: SUPERVISOR_INSTALLATION pidiendo PRODUCTION -> DENIED", async () => {
  await assert.rejects(
    () => getDailyReview(createMockSupabase() as never, "SUPERVISOR_INSTALLATION", "PRODUCTION", "2026-08-17"),
    DailyReviewAuthorizationError
  );
});

test("getDailyReview: SUPERVISOR_PRODUCTION pidiendo su propia área -> ALLOWED", async () => {
  const result = await getDailyReview(createMockSupabase() as never, "SUPERVISOR_PRODUCTION", "PRODUCTION", "2026-08-17");
  assert.equal(result.groupCode, "PRODUCTION");
});

test("getDailyReview: SUPER_ADMIN puede pedir cualquier área", async () => {
  await getDailyReview(createMockSupabase() as never, "SUPER_ADMIN", "INSTALLATION", "2026-08-17");
  await getDailyReview(createMockSupabase() as never, "SUPER_ADMIN", "ADMINISTRATION", "2026-08-17");
});

test("getDailyReview: ADMIN_RRHH puede pedir cualquier área", async () => {
  await getDailyReview(createMockSupabase() as never, "ADMIN_RRHH", "PRODUCTION", "2026-08-17");
  await getDailyReview(createMockSupabase() as never, "ADMIN_RRHH", "ADMINISTRATION", "2026-08-17");
});

test("getDailyReview: sin trabajadores en el área -> listas vacías, no lanza", async () => {
  const result = await getDailyReview(createMockSupabase() as never, "SUPER_ADMIN", "PRODUCTION", "2026-08-17");
  assert.deepEqual(result.requiresReview, []);
  assert.deepEqual(result.noIssues, []);
});
