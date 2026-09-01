import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../supabase/admin-client";
import type { Database } from "../supabase/database.types";

export type InvitationDeliveryResult =
  | { status: "SENT" }
  | { status: "ACCOUNT_EXISTS" }
  | { status: "FAILED"; errorCode: string };

export function isExistingAccountError(error: { code?: string; message?: string }): boolean {
  const code = error.code?.toLowerCase();
  const message = error.message?.toLowerCase() ?? "";
  return code === "email_exists" || code === "user_already_exists" || message.includes("already been registered");
}

function safeErrorCode(error: { code?: string }): string {
  return (error.code ?? "email_delivery_failed").slice(0, 80);
}

export async function deliverCompanyInvitation(email: string, redirectTo: string): Promise<InvitationDeliveryResult> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (!error) return { status: "SENT" };
    if (isExistingAccountError(error)) return { status: "ACCOUNT_EXISTS" };
    console.error("[platform] invitation email delivery failed", safeErrorCode(error));
    return { status: "FAILED", errorCode: safeErrorCode(error) };
  } catch (error) {
    console.error("[platform] invitation email delivery unavailable", error instanceof Error ? error.message : "unknown");
    return { status: "FAILED", errorCode: "email_delivery_unavailable" };
  }
}

export async function acceptCurrentUserInvitations(supabase: SupabaseClient<Database>): Promise<number> {
  const { data, error } = await supabase.rpc("accept_my_company_invitations");
  if (error) {
    console.error("[auth] invitation acceptance failed", error.code ?? "unknown");
    return 0;
  }
  return data ?? 0;
}

