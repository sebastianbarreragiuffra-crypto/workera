import "server-only";
import { checkRateLimit } from "@vercel/firewall";
import { headers } from "next/headers";
import { trustedVercelClientIp } from "./edge-rate-limit";

export const SENSITIVE_SERVER_ACTION_POLICIES = [
  "gestora-login-action",
  "gestora-mfa-challenge-action",
  "gestora-mfa-management-action",
] as const;

export type SensitiveServerActionPolicy = typeof SENSITIVE_SERVER_ACTION_POLICIES[number];
export type SensitiveServerActionRateLimitOutcome = "allowed" | "limited" | "unavailable";

interface Environment {
  readonly VERCEL?: string;
  readonly NODE_ENV?: string;
  readonly EDGE_RATE_LIMIT_ENABLED?: string;
  readonly EDGE_RATE_LIMIT_EXPECT_ENABLED?: string;
}

type Checker = typeof checkRateLimit;
type HeadersReader = () => Promise<Headers>;

/**
 * Server Actions can be forwarded by Next.js from a pathname different from
 * the page that declared them. This second check lives inside the action, so
 * the action identity — not the caller-controlled URL — selects the bucket.
 * Its hosted IDs are intentionally distinct from the proxy rules: a normal
 * submission consumes one entry in each independent bucket, not two entries
 * in the same one.
 */
export async function checkSensitiveServerActionRateLimit(
  policy: SensitiveServerActionPolicy,
  checker: Checker = checkRateLimit,
  env: Environment = process.env,
  readHeaders: HeadersReader = async () => new Headers(await headers()),
): Promise<SensitiveServerActionRateLimitOutcome> {
  const enabled = env.EDGE_RATE_LIMIT_ENABLED === "true";
  const expected = env.EDGE_RATE_LIMIT_EXPECT_ENABLED === "true";
  if (!enabled || env.VERCEL !== "1") return expected ? "unavailable" : "allowed";

  try {
    const requestHeaders = await readHeaders();
    const clientIp = trustedVercelClientIp(requestHeaders, env);
    if (!clientIp) {
      console.error("[edge-rate-limit] identidad de Server Action no disponible", {
        event: "server_action_rate_limit_identity_unavailable",
        policyId: policy,
      });
      return "unavailable";
    }
    const result = await checker(policy, { headers: requestHeaders, rateLimitKey: clientIp });
    if (result.error) {
      console.error("[edge-rate-limit] control de Server Action no disponible", {
        event: result.error === "not-found"
          ? "server_action_rate_limit_rule_missing"
          : "server_action_rate_limit_check_blocked",
        policyId: policy,
      });
      return "unavailable";
    }
    if (result.rateLimited) {
      console.warn("[edge-rate-limit] Server Action limitada", {
        event: "server_action_rate_limit_rejected",
        policyId: policy,
      });
      return "limited";
    }
    return "allowed";
  } catch (cause) {
    console.error("[edge-rate-limit] verificación de Server Action no disponible", {
      event: "server_action_rate_limit_check_failed",
      policyId: policy,
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    return "unavailable";
  }
}
