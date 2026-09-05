import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceExportPeriod } from "../business-rules/attendance-export-periods";
import type { Database } from "../supabase/database.types";

export type WorkforceDataAccessInput =
  | { scope: "attendance.export"; period: AttendanceExportPeriod }
  | { scope: "payroll_batch.export"; resourceId: string }
  | { scope: "supplier_master.download" };

export type WorkforceDataAccessDecision =
  | {
      status: "ALLOWED";
      remaining: number;
      requestLimit: number;
      storagePath: string | null;
      originalFilename: string | null;
    }
  | { status: "RATE_LIMITED"; retryAfterSeconds: number; requestLimit: number }
  | { status: "DENIED" }
  | { status: "UNAVAILABLE" };

const DENIED_DATABASE_CODES = new Set(["22023", "42501", "P0002"]);

/**
 * Segunda autoridad para descargas laborales legacy. PostgreSQL deriva
 * ARCOTEX, revalida membresia/rol/MFA/recurso, consume cuota y audita antes de
 * que el handler consulte o entregue datos.
 */
export async function authorizeWorkforceDataAccess(
  supabase: SupabaseClient<Database>,
  input: WorkforceDataAccessInput,
): Promise<WorkforceDataAccessDecision> {
  const period = input.scope === "attendance.export" ? input.period : null;
  const resourceId = input.scope === "payroll_batch.export" ? input.resourceId : null;
  const { data, error } = await supabase.rpc("authorize_workforce_data_access", {
    p_scope: input.scope,
    p_resource_id: resourceId,
    p_period_type: period?.type ?? null,
    p_period_start: period?.startDate ?? null,
    p_period_end: period?.endDate ?? null,
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
  if (input.scope === "supplier_master.download" && (!data.storage_path || !data.original_filename)) {
    return { status: "UNAVAILABLE" };
  }
  return {
    status: "ALLOWED",
    remaining: Math.max(0, data.remaining),
    requestLimit: data.request_limit,
    storagePath: data.storage_path,
    originalFilename: data.original_filename,
  };
}

const PRIVATE_FAILURE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

export function workforceDataAccessFailureResponse(
  decision: WorkforceDataAccessDecision,
  options: { deniedStatus?: 403 | 404; deniedMessage?: string } = {},
): Response | null {
  if (decision.status === "ALLOWED") return null;
  if (decision.status === "RATE_LIMITED") {
    return new Response("Demasiadas descargas. Intenta nuevamente mas tarde.", {
      status: 429,
      headers: {
        ...PRIVATE_FAILURE_HEADERS,
        "Retry-After": String(decision.retryAfterSeconds),
        "RateLimit-Limit": String(decision.requestLimit),
        "RateLimit-Remaining": "0",
      },
    });
  }
  if (decision.status === "DENIED") {
    return new Response(options.deniedMessage ?? "No autorizado.", {
      status: options.deniedStatus ?? 403,
      headers: PRIVATE_FAILURE_HEADERS,
    });
  }
  return new Response("No fue posible autorizar la descarga.", {
    status: 503,
    headers: PRIVATE_FAILURE_HEADERS,
  });
}

export function workforceRateLimitHeaders(
  decision: Extract<WorkforceDataAccessDecision, { status: "ALLOWED" }>,
): Record<string, string> {
  return {
    "RateLimit-Limit": String(decision.requestLimit),
    "RateLimit-Remaining": String(decision.remaining),
  };
}
