import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseCompanyContext } from "@/lib/expenses/access";
import type { Database } from "@/lib/supabase/database.types";

export type ExpenseDataAccessScope =
  | "receipt.download"
  | "capture.download"
  | "reconciliation.export"
  | "accounting.export";

export type ExpenseDataAccessDecision =
  | { status: "ALLOWED"; remaining: number; requestLimit: number }
  | { status: "RATE_LIMITED"; retryAfterSeconds: number; requestLimit: number }
  | { status: "DENIED" }
  | { status: "UNAVAILABLE" };

const DENIED_DATABASE_CODES = new Set(["22023", "42501", "P0002"]);

/**
 * Segunda autoridad, ademas del Route Handler y RLS. Postgres revalida el
 * recurso, consume el contador compartido y escribe auditoria en una sola
 * transaccion antes de que la aplicacion entregue datos financieros.
 */
export async function authorizeExpenseDataAccess(
  supabase: SupabaseClient<Database>,
  context: Pick<ExpenseCompanyContext, "id">,
  scope: ExpenseDataAccessScope,
  resourceId: string | null = null
): Promise<ExpenseDataAccessDecision> {
  const { data, error } = await supabase.rpc("authorize_expense_data_access", {
    p_company_id: context.id,
    p_scope: scope,
    p_resource_id: resourceId,
  }).maybeSingle();

  if (error) {
    if (DENIED_DATABASE_CODES.has(error.code ?? "")) return { status: "DENIED" };
    return { status: "UNAVAILABLE" };
  }
  if (!data) return { status: "UNAVAILABLE" };
  if (!data.allowed) {
    return {
      status: "RATE_LIMITED",
      retryAfterSeconds: Math.max(1, Math.min(86_400, data.retry_after_seconds)),
      requestLimit: data.request_limit,
    };
  }
  return {
    status: "ALLOWED",
    remaining: Math.max(0, data.remaining),
    requestLimit: data.request_limit,
  };
}

export function expenseDataAccessFailureResponse(
  decision: ExpenseDataAccessDecision,
  options: { deniedStatus?: 403 | 404; deniedMessage?: string } = {}
): Response | null {
  if (decision.status === "ALLOWED") return null;

  const commonHeaders = {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
  if (decision.status === "RATE_LIMITED") {
    return new Response("Demasiadas solicitudes. Intenta nuevamente mas tarde.", {
      status: 429,
      headers: { ...commonHeaders, "Retry-After": String(decision.retryAfterSeconds) },
    });
  }
  if (decision.status === "DENIED") {
    return new Response(options.deniedMessage ?? "No autorizado.", {
      status: options.deniedStatus ?? 403,
      headers: commonHeaders,
    });
  }
  return new Response("No fue posible autorizar la descarga.", {
    status: 503,
    headers: commonHeaders,
  });
}
