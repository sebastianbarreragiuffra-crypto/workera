import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  authorizeExpenseDataAccess,
  expenseDataAccessFailureResponse,
} from "./data-access-guard";

function clientReturning(result: unknown) {
  return {
    rpc(name: string, args: unknown) {
      assert.equal(name, "authorize_expense_data_access");
      assert.deepEqual(args, {
        p_company_id: "company-1",
        p_scope: "receipt.download",
        p_resource_id: "receipt-1",
      });
      return { maybeSingle: async () => result };
    },
  } as unknown as SupabaseClient<Database>;
}

test("normaliza una autorizacion sin exponer la fila RPC", async () => {
  const decision = await authorizeExpenseDataAccess(
    clientReturning({ data: { allowed: true, remaining: 59, request_limit: 60, retry_after_seconds: 0 }, error: null }),
    { id: "company-1" },
    "receipt.download",
    "receipt-1"
  );
  assert.deepEqual(decision, { status: "ALLOWED", remaining: 59, requestLimit: 60 });
  assert.equal(expenseDataAccessFailureResponse(decision), null);
});

test("un limite produce 429, Retry-After y no-store", async () => {
  const decision = await authorizeExpenseDataAccess(
    clientReturning({ data: { allowed: false, remaining: 0, request_limit: 60, retry_after_seconds: 47 }, error: null }),
    { id: "company-1" },
    "receipt.download",
    "receipt-1"
  );
  assert.deepEqual(decision, { status: "RATE_LIMITED", retryAfterSeconds: 47, requestLimit: 60 });
  const response = expenseDataAccessFailureResponse(decision);
  assert.equal(response?.status, 429);
  assert.equal(response?.headers.get("retry-after"), "47");
  assert.match(response?.headers.get("cache-control") ?? "", /no-store/);
});

test("rechazos de autorizacion se ocultan como 404 cuando el recurso es sensible", async () => {
  const decision = await authorizeExpenseDataAccess(
    clientReturning({ data: null, error: { code: "42501", message: "detalle interno" } }),
    { id: "company-1" },
    "receipt.download",
    "receipt-1"
  );
  assert.deepEqual(decision, { status: "DENIED" });
  const response = expenseDataAccessFailureResponse(decision, {
    deniedStatus: 404,
    deniedMessage: "Comprobante no encontrado.",
  });
  assert.equal(response?.status, 404);
});

test("un fallo inesperado cierra la entrega con 503 generico", async () => {
  const decision = await authorizeExpenseDataAccess(
    clientReturning({ data: null, error: { code: "XX000", message: "nombre_tabla_secreto" } }),
    { id: "company-1" },
    "receipt.download",
    "receipt-1"
  );
  assert.deepEqual(decision, { status: "UNAVAILABLE" });
  const response = expenseDataAccessFailureResponse(decision);
  assert.equal(response?.status, 503);
  assert.doesNotMatch(await response!.text(), /nombre_tabla_secreto/);
});
