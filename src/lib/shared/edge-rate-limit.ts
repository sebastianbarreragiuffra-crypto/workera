import { isIP } from "node:net";
import { checkRateLimit } from "@vercel/firewall";
import { NextResponse, type NextRequest } from "next/server";

export interface EdgeRateLimitPolicy {
  readonly id: string;
  readonly method: string;
  readonly pathname: string;
  readonly requestLimit: number;
  readonly windowSeconds: number;
}

export const EDGE_RATE_LIMIT_POLICIES = [
  { id: "gestora-login", method: "POST", pathname: "/login", requestLimit: 10, windowSeconds: 300 },
  { id: "gestora-auth-callback", method: "GET", pathname: "/auth/callback", requestLimit: 30, windowSeconds: 60 },
  { id: "gestora-auth-confirm", method: "GET", pathname: "/auth/confirm", requestLimit: 30, windowSeconds: 60 },
  { id: "gestora-meta-verify", method: "GET", pathname: "/api/webhooks/meta/expense-receipts", requestLimit: 20, windowSeconds: 600 },
  { id: "gestora-meta-events", method: "POST", pathname: "/api/webhooks/meta/expense-receipts", requestLimit: 120, windowSeconds: 60 },
  { id: "gestora-resend-events", method: "POST", pathname: "/api/webhooks/resend/expense-receipts", requestLimit: 120, windowSeconds: 60 },
] as const satisfies readonly EdgeRateLimitPolicy[];

interface RateLimitResult {
  readonly rateLimited: boolean;
  readonly error?: "not-found" | "blocked";
}

type RateLimitChecker = (
  rateLimitId: string,
  options: { request: Request; rateLimitKey: string },
) => Promise<RateLimitResult>;

interface EdgeEnvironment {
  readonly VERCEL?: string;
  readonly NODE_ENV?: string;
}

export function findEdgeRateLimitPolicy(request: Pick<NextRequest, "method" | "nextUrl">): EdgeRateLimitPolicy | null {
  return EDGE_RATE_LIMIT_POLICIES.find(
    (policy) => policy.method === request.method && policy.pathname === request.nextUrl.pathname,
  ) ?? null;
}

/**
 * Vercel overwrites x-forwarded-for, but x-vercel-forwarded-for remains the
 * provider-specific client identity even when another proxy sits in front.
 * We only trust it inside a Vercel deployment and require one canonical IP;
 * caller-controlled forwarding headers never participate in the key.
 */
export function trustedVercelClientIp(headers: Headers, env: EdgeEnvironment = process.env): string | null {
  if (env.VERCEL !== "1") return null;
  const candidate = headers.get("x-vercel-forwarded-for")?.trim();
  if (!candidate || candidate.includes(",") || isIP(candidate) === 0) return null;
  return candidate;
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "service_unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
  );
}

function limitedResponse(policy: EdgeRateLimitPolicy): NextResponse {
  return NextResponse.json(
    { error: "too_many_requests" },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(policy.windowSeconds),
      },
    },
  );
}

/**
 * Application hook for Vercel WAF. Non-sensitive routes and local development
 * do not call the hosted limiter. On Vercel, a missing identity, missing rule,
 * blocked checker, or unexpected provider failure closes the protected path.
 */
export async function enforceEdgeRateLimit(
  request: NextRequest,
  checker: RateLimitChecker = checkRateLimit,
  env: EdgeEnvironment = process.env,
): Promise<NextResponse | null> {
  const policy = findEdgeRateLimitPolicy(request);
  if (!policy || env.VERCEL !== "1") return null;

  const clientIp = trustedVercelClientIp(request.headers, env);
  if (!clientIp) {
    console.error("[edge-rate-limit] identidad de cliente no disponible", {
      event: "edge_rate_limit_identity_unavailable",
      policyId: policy.id,
    });
    return unavailableResponse();
  }

  try {
    const result = await checker(policy.id, { request, rateLimitKey: clientIp });
    if (result.error === "not-found") {
      console.error("[edge-rate-limit] regla hospedada no configurada", {
        event: "edge_rate_limit_rule_missing",
        policyId: policy.id,
      });
      return unavailableResponse();
    }
    if (result.rateLimited) {
      console.warn("[edge-rate-limit] solicitud limitada", {
        event: "edge_rate_limit_rejected",
        policyId: policy.id,
      });
      return limitedResponse(policy);
    }
    return null;
  } catch (error) {
    console.error("[edge-rate-limit] verificacion hospedada no disponible", {
      event: "edge_rate_limit_check_failed",
      policyId: policy.id,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return unavailableResponse();
  }
}
