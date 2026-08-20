import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateBirthdayContributionPerWorker } from "./birthday-contribution";

test("suma $1.000 por cada persona que está de cumpleaños", () => {
  assert.equal(calculateBirthdayContributionPerWorker(3), 3_000);
  assert.equal(calculateBirthdayContributionPerWorker(0), 0);
});
