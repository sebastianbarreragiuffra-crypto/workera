import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySyncError, isRetryableSyncErrorCategory } from "./errors";
import {
  WorkeraAuthenticationError,
  WorkeraAuthorizationError,
  WorkeraRateLimitError,
  WorkeraTimeoutError,
  WorkeraNetworkError,
  WorkeraServerError,
  WorkeraValidationError,
  WorkeraConfigurationError,
  isRetryableWorkeraError,
} from "../workera/errors";

test("classifySyncError: mapea cada subclase de WorkeraError a su categoría estable", () => {
  assert.equal(classifySyncError(new WorkeraAuthenticationError("x")), "WORKERA_AUTH");
  assert.equal(classifySyncError(new WorkeraAuthorizationError("x")), "WORKERA_AUTH");
  assert.equal(classifySyncError(new WorkeraRateLimitError("x")), "WORKERA_RATE_LIMIT");
  assert.equal(classifySyncError(new WorkeraTimeoutError("x")), "WORKERA_TIMEOUT");
  assert.equal(classifySyncError(new WorkeraNetworkError("x")), "WORKERA_NETWORK");
  assert.equal(classifySyncError(new WorkeraServerError("x", 500)), "WORKERA_SERVER");
  assert.equal(classifySyncError(new WorkeraValidationError("x", [])), "WORKERA_PAYLOAD");
  assert.equal(classifySyncError(new WorkeraConfigurationError("x")), "CONFIGURATION");
});

test("classifySyncError: cualquier otro error (Postgres/Supabase) cae en DATABASE por defecto", () => {
  assert.equal(classifySyncError(new Error("connection reset")), "DATABASE");
  assert.equal(classifySyncError("string suelto"), "DATABASE");
  assert.equal(classifySyncError(null), "DATABASE");
});

test("isRetryableSyncErrorCategory: mismo criterio que isRetryableWorkeraError (Fase 4/5) -- nunca una política contradictoria", () => {
  const cases: [unknown, boolean][] = [
    [new WorkeraNetworkError("x"), true],
    [new WorkeraTimeoutError("x"), true],
    [new WorkeraRateLimitError("x"), true],
    [new WorkeraServerError("x", 503), true],
    [new WorkeraAuthenticationError("x"), false],
    [new WorkeraAuthorizationError("x"), false],
    [new WorkeraValidationError("x", []), false],
    [new WorkeraConfigurationError("x"), false],
  ];

  for (const [err, expectedRetryable] of cases) {
    const category = classifySyncError(err);
    assert.equal(
      isRetryableSyncErrorCategory(category),
      isRetryableWorkeraError(err),
      `categoría "${category}" debe coincidir con isRetryableWorkeraError para ${(err as Error).constructor.name}`
    );
    assert.equal(isRetryableSyncErrorCategory(category), expectedRetryable);
  }
});

test("isRetryableSyncErrorCategory: null/undefined nunca es retryable", () => {
  assert.equal(isRetryableSyncErrorCategory(null), false);
  assert.equal(isRetryableSyncErrorCategory(undefined), false);
});

test("isRetryableSyncErrorCategory: categorías no-Workera (DATABASE/CONCURRENCY/EMPLOYEE_RESOLUTION) no son retryable automáticamente", () => {
  assert.equal(isRetryableSyncErrorCategory("DATABASE"), false);
  assert.equal(isRetryableSyncErrorCategory("CONCURRENCY"), false);
  assert.equal(isRetryableSyncErrorCategory("EMPLOYEE_RESOLUTION"), false);
});
