import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export type PlatformActionLimitInput =
  | { scope: "platform.company.create" }
  | { scope: "platform.invitation.create"; companyId: string }
  | { scope: "platform.invitation.resend"; companyId: string; resourceId: string }
  | { scope: "platform.role.assign"; companyId: string; resourceId: string }
  | { scope: "platform.module.change"; companyId: string }
  | { scope: "platform.onboarding.change"; companyId: string }
  | { scope: "platform.organization.create"; companyId: string }
  | { scope: "platform.mfa.reset"; resourceId: string };

export type PlatformActionLimitDecision =
  | { status: "ALLOWED"; requestLimit: number; remaining: number }
  | { status: "RATE_LIMITED"; requestLimit: number; retryAfterSeconds: number }
  | { status: "DENIED" }
  | { status: "UNAVAILABLE" };

const DENIED_DATABASE_CODES = new Set(["22023", "42501", "P0002"]);

export async function consumePlatformActionRateLimit(
  supabase: SupabaseClient<Database>,
  input: PlatformActionLimitInput,
): Promise<PlatformActionLimitDecision> {
  const companyId = "companyId" in input ? input.companyId : null;
  const resourceId = "resourceId" in input ? input.resourceId : null;
  const { data, error } = await supabase.rpc("consume_platform_action_rate_limit", {
    p_scope: input.scope,
    p_company_id: companyId,
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
      requestLimit: data.request_limit,
      retryAfterSeconds: Math.max(1, Math.min(86_400, data.retry_after_seconds)),
    };
  }
  return {
    status: "ALLOWED",
    requestLimit: data.request_limit,
    remaining: Math.max(0, data.remaining),
  };
}

export class PlatformActionLimitError extends Error {
  readonly reason: Exclude<PlatformActionLimitDecision["status"], "ALLOWED">;
  readonly retryAfterSeconds: number | null;

  constructor(decision: Exclude<PlatformActionLimitDecision, { status: "ALLOWED" }>) {
    const message = decision.status === "RATE_LIMITED"
      ? `Demasiados cambios seguidos. Espera ${decision.retryAfterSeconds} segundos e intenta nuevamente.`
      : decision.status === "DENIED"
        ? "Tu sesión no permite realizar esta acción."
        : "No pudimos comprobar el límite de seguridad. Intenta nuevamente.";
    super(message);
    this.name = "PlatformActionLimitError";
    this.reason = decision.status;
    this.retryAfterSeconds = decision.status === "RATE_LIMITED" ? decision.retryAfterSeconds : null;
  }
}

export function assertPlatformActionLimit(
  decision: PlatformActionLimitDecision,
): asserts decision is Extract<PlatformActionLimitDecision, { status: "ALLOWED" }> {
  if (decision.status !== "ALLOWED") throw new PlatformActionLimitError(decision);
}
