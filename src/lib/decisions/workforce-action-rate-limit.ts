import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertApplicationActionLimit,
  consumeApplicationActionRateLimit,
  type ApplicationMutationScope,
} from "../shared/action-rate-limit";
import type { Database } from "../supabase/database.types";

export type WorkforceMutationScope = Exclude<ApplicationMutationScope, "expenses.workflow.mutate">;

/**
 * La empresa se omite deliberadamente: el RPC deriva ARCOTEX y rechaza que el
 * navegador intente elegir otro tenant mientras el dominio laboral sea legacy.
 */
export async function enforceWorkforceActionRateLimit(
  supabase: SupabaseClient<Database>,
  scope: WorkforceMutationScope,
): Promise<void> {
  const decision = await consumeApplicationActionRateLimit(supabase, { scope });
  assertApplicationActionLimit(decision);
}
