import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkeraConfigurationError,
  WorkeraAuthenticationError,
  WorkeraAuthorizationError,
  WorkeraRateLimitError,
  WorkeraValidationError,
  WorkeraNetworkError,
  WorkeraTimeoutError,
  WorkeraServerError,
  isRetryableWorkeraError,
} from "./errors";

test("errores retryable: network, timeout, rate limit y server error", () => {
  assert.equal(isRetryableWorkeraError(new WorkeraNetworkError("net")), true);
  assert.equal(isRetryableWorkeraError(new WorkeraTimeoutError("timeout")), true);
  assert.equal(isRetryableWorkeraError(new WorkeraRateLimitError("429")), true);
  assert.equal(isRetryableWorkeraError(new WorkeraServerError("500", 500)), true);
});

test("errores NO retryable: configuración, auth, autorización, validación", () => {
  assert.equal(isRetryableWorkeraError(new WorkeraConfigurationError("cfg")), false);
  assert.equal(isRetryableWorkeraError(new WorkeraAuthenticationError("401")), false);
  assert.equal(isRetryableWorkeraError(new WorkeraAuthorizationError("403")), false);
  assert.equal(
    isRetryableWorkeraError(new WorkeraValidationError("invalid", [{ path: "id", message: "required" }])),
    false
  );
});

test("un Error genérico (no Workera) no se clasifica como retryable", () => {
  assert.equal(isRetryableWorkeraError(new Error("boom")), false);
});

test("cada error tiene su code y name correctos", () => {
  const err = new WorkeraValidationError("bad payload", [{ path: "id", message: "required" }]);
  assert.equal(err.code, "WORKERA_VALIDATION_ERROR");
  assert.equal(err.name, "WorkeraValidationError");
  assert.equal(err.issues.length, 1);
});
