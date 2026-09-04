import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";

export async function purgeExpiredExpenseAssistantQueriesWithServiceRole(): Promise<number> {
  const { data, error } = await createAdminClient().rpc("purge_expired_expense_assistant_queries");
  if (error || data === null) throw new Error("No se pudo purgar el historial del asistente.");
  return data;
}
