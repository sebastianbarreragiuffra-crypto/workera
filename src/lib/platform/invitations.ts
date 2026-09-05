import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export class InvitationAcceptanceError extends Error {
  constructor() {
    super("No pudimos completar las invitaciones pendientes de esta cuenta.");
    this.name = "InvitationAcceptanceError";
  }
}

export async function acceptCurrentUserInvitations(supabase: SupabaseClient<Database>): Promise<number> {
  const { data, error } = await supabase.rpc("accept_my_company_invitations");
  if (error) {
    console.error("[auth] invitation acceptance failed", error.code ?? "unknown");
    throw new InvitationAcceptanceError();
  }
  return data ?? 0;
}
