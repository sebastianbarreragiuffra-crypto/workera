import "server-only";

import { createAdminClient } from "../supabase/admin-client";

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

/**
 * Límite privilegiado para Supabase Auth. La autorización de plataforma y el
 * registro de la invitación ocurren antes, usando el cliente de sesión sujeto a
 * RLS. Este servicio solo entrega el correo que Auth no permite enviar con una
 * sesión normal.
 */
export async function deliverCompanyInvitation(email: string, redirectTo: string): Promise<InvitationDeliveryResult> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (!error) return { status: "SENT" };
    if (isExistingAccountError(error)) return { status: "ACCOUNT_EXISTS" };
    const errorCode = safeErrorCode(error);
    console.error("[platform] invitation email delivery failed", errorCode);
    return { status: "FAILED", errorCode };
  } catch {
    console.error("[platform] invitation email delivery unavailable");
    return { status: "FAILED", errorCode: "email_delivery_unavailable" };
  }
}
