import assert from "node:assert/strict";
import test from "node:test";
import { validateAddedMigrationOrder } from "./migration-order";

test("una migracion nueva debe avanzar respecto del ultimo timestamp base", () => {
  const base = ["supabase/migrations/20260905160000_previous.sql"];
  const valid = "supabase/migrations/20260905170000_next.sql";
  assert.deepEqual(validateAddedMigrationOrder(base, [...base, valid], [valid]), []);

  const late = "supabase/migrations/20260904170000_late.sql";
  assert.deepEqual(validateAddedMigrationOrder(base, [...base, late], [late]), [
    { path: late, reason: "NOT_AFTER_BASE" },
  ]);
});

test("versiones duplicadas y nombres no canonicos fallan cerrados", () => {
  const base = ["supabase/migrations/20260905160000_previous.sql"];
  const first = "supabase/migrations/20260905170000_first.sql";
  const duplicate = "supabase/migrations/20260905170000_second.sql";
  const invalid = "supabase/migrations/not-a-timestamp.sql";
  assert.deepEqual(
    validateAddedMigrationOrder(base, [...base, first, duplicate, invalid], [duplicate, invalid]),
    [
      { path: duplicate, reason: "DUPLICATE_VERSION" },
      { path: invalid, reason: "INVALID_NAME" },
    ],
  );
});
