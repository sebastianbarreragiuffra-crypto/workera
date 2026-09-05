import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export type ApplicationMutationScope =
  | "expenses.workflow.mutate"
  | "workforce.review.mutate"
  | "workforce.medical.decide"
  | "workforce.schedules.manage"
  | "workforce.periods.manage"
  | "workforce.payroll.manage"
  | "workforce.roster.manage"
  | "workforce.meals.manage"
  | "workforce.rule_engine.run"
  | "workforce.sync.rerun";

export interface ApplicationActionLimitInput {
  scope: ApplicationMutationScope;
  companyId?: string | null;
}

export type ApplicationActionLimitDecision =
  | { status: "ALLOWED"; requestLimit: number; remaining: number }
  | { status: "RATE_LIMITED"; requestLimit: number; retryAfterSeconds: number }
  | { status: "DENIED" }
  | { status: "UNAVAILABLE" };

const DENIED_DATABASE_CODES = new Set(["22023", "42501", "P0001", "P0002"]);

export async function consumeApplicationActionRateLimit(
  supabase: SupabaseClient<Database>,
  input: ApplicationActionLimitInput,
): Promise<ApplicationActionLimitDecision> {
  const { data, error } = await supabase.rpc("consume_application_action_rate_limit", {
    p_scope: input.scope,
    p_company_id: input.companyId ?? null,
  }).maybeSingle();

  if (error) {
    if (DENIED_DATABASE_CODES.has(error.code ?? "")) return { status: "DENIED" };
    return { status: "UNAVAILABLE" };
  }
  if (!data) return { status: "UNAVAILABLE" };
  if (!data.allowed) return {
    status: "RATE_LIMITED",
    requestLimit: data.request_limit,
    retryAfterSeconds: Math.max(1, Math.min(86_400, data.retry_after_seconds)),
  };
  return {
    status: "ALLOWED",
    requestLimit: data.request_limit,
    remaining: Math.max(0, data.remaining),
  };
}

export function applicationActionLimitMessage(decision: ApplicationActionLimitDecision): string | null {
  if (decision.status === "ALLOWED") return null;
  if (decision.status === "RATE_LIMITED") {
    return `Hiciste demasiados cambios seguidos. Espera ${decision.retryAfterSeconds} segundos e intenta nuevamente.`;
  }
  if (decision.status === "DENIED") return "Tu sesión no permite realizar esta acción.";
  return "No pudimos comprobar el límite de seguridad. Intenta nuevamente.";
}

export class ApplicationActionLimitError extends Error {
  readonly decision: Exclude<ApplicationActionLimitDecision, { status: "ALLOWED" }>;

  constructor(decision: Exclude<ApplicationActionLimitDecision, { status: "ALLOWED" }>) {
    super(applicationActionLimitMessage(decision) ?? "Acción bloqueada.");
    this.name = "ApplicationActionLimitError";
    this.decision = decision;
  }
}

export function assertApplicationActionLimit(
  decision: ApplicationActionLimitDecision,
): asserts decision is Extract<ApplicationActionLimitDecision, { status: "ALLOWED" }> {
  if (decision.status !== "ALLOWED") throw new ApplicationActionLimitError(decision);
}
