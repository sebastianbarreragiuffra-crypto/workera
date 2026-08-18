import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkeraError,
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

/**
 * Contrato por clase (sección "Baseline obligatorio" del encargo de
 * fortalecimiento de tests): cada una de las 8 clases hereda de
 * WorkeraError/Error, expone `name` vía `this.constructor.name`, `message`
 * vía `super(message)` y su `code` fijo. Solo se verifican los campos que
 * cada clase realmente declara en errors.ts — no se inventa `cause` (el
 * constructor base nunca lo lee ni lo pasa a `super()`).
 */

test("WorkeraConfigurationError: instancia, name, message y code", () => {
  const err = new WorkeraConfigurationError("WORKERA_PROVIDER debe ser http en producción");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraConfigurationError);
  assert.equal(err.name, "WorkeraConfigurationError");
  assert.equal(err.message, "WORKERA_PROVIDER debe ser http en producción");
  assert.equal(err.code, "WORKERA_CONFIGURATION_ERROR");
});

test("WorkeraAuthenticationError: instancia, name, message y code", () => {
  const err = new WorkeraAuthenticationError("credenciales rechazadas (401)");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraAuthenticationError);
  assert.equal(err.name, "WorkeraAuthenticationError");
  assert.equal(err.message, "credenciales rechazadas (401)");
  assert.equal(err.code, "WORKERA_AUTHENTICATION_ERROR");
});

test("WorkeraAuthorizationError: instancia, name, message y code", () => {
  const err = new WorkeraAuthorizationError("sin permiso para la operación (403)");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraAuthorizationError);
  assert.equal(err.name, "WorkeraAuthorizationError");
  assert.equal(err.message, "sin permiso para la operación (403)");
  assert.equal(err.code, "WORKERA_AUTHORIZATION_ERROR");
});

test("WorkeraRateLimitError: instancia, name, message, code y retryAfterMs (con y sin valor)", () => {
  const withRetry = new WorkeraRateLimitError("rate limited (429)", 5000);
  assert.ok(withRetry instanceof Error);
  assert.ok(withRetry instanceof WorkeraError);
  assert.ok(withRetry instanceof WorkeraRateLimitError);
  assert.equal(withRetry.name, "WorkeraRateLimitError");
  assert.equal(withRetry.message, "rate limited (429)");
  assert.equal(withRetry.code, "WORKERA_RATE_LIMIT_ERROR");
  assert.equal(withRetry.retryAfterMs, 5000);

  const withoutRetry = new WorkeraRateLimitError("rate limited sin Retry-After informado");
  assert.equal(withoutRetry.retryAfterMs, undefined);
});

test("WorkeraValidationError: instancia, name, message, code e issues completos", () => {
  const issues = [
    { path: "id", message: "required" },
    { path: "active", message: "expected boolean" },
  ];
  const err = new WorkeraValidationError("payload no cumple el schema", issues);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraValidationError);
  assert.equal(err.name, "WorkeraValidationError");
  assert.equal(err.message, "payload no cumple el schema");
  assert.equal(err.code, "WORKERA_VALIDATION_ERROR");
  assert.deepEqual(err.issues, issues);
});

test("WorkeraNetworkError: instancia, name, message y code", () => {
  const err = new WorkeraNetworkError("conexión rechazada");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraNetworkError);
  assert.equal(err.name, "WorkeraNetworkError");
  assert.equal(err.message, "conexión rechazada");
  assert.equal(err.code, "WORKERA_NETWORK_ERROR");
});

test("WorkeraTimeoutError: instancia, name, message y code", () => {
  const err = new WorkeraTimeoutError("request excedió el timeout configurado");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraTimeoutError);
  assert.equal(err.name, "WorkeraTimeoutError");
  assert.equal(err.message, "request excedió el timeout configurado");
  assert.equal(err.code, "WORKERA_TIMEOUT_ERROR");
});

test("WorkeraServerError: instancia, name, message, code y statusCode", () => {
  const err = new WorkeraServerError("service unavailable", 503);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof WorkeraError);
  assert.ok(err instanceof WorkeraServerError);
  assert.equal(err.name, "WorkeraServerError");
  assert.equal(err.message, "service unavailable");
  assert.equal(err.code, "WORKERA_SERVER_ERROR");
  assert.equal(err.statusCode, 503);
});

test("el contexto de diagnóstico opcional se almacena tal cual, en clases con y sin parámetros extra", () => {
  const context = { operation: "getEmployees", externalId: "MOCK-001" };

  const simple = new WorkeraNetworkError("dns failure", context);
  assert.deepEqual(simple.context, context);

  const withExtraArg = new WorkeraServerError("bad gateway", 502, context);
  assert.deepEqual(withExtraArg.context, context);

  const noContext = new WorkeraConfigurationError("missing base url");
  assert.equal(noContext.context, undefined);
});
