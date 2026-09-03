import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { expenseEmailAddress, getExpenseEmailDomain, getExpenseEmailProviderConfig } from "@/lib/expense-email/config";
import type { ExpenseCompanyContext } from "./access";
import type { Database } from "@/lib/supabase/database.types";

export interface ExpenseEmailConnectorDto {
  configured: boolean;
  enabled: boolean;
  address: string | null;
}

export async function getExpenseEmailConnector(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<ExpenseEmailConnectorDto> {
  const domain = getExpenseEmailDomain();
  if (!domain) return { configured: false, enabled: false, address: null };

  const { data, error } = await supabase
    .from("expense_receipt_email_aliases")
    .select("alias_token")
    .eq("company_id", context.id)
    .eq("user_id", context.userId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error("No pudimos cargar la dirección de recepción.");

  return {
    configured: true,
    enabled: getExpenseEmailProviderConfig()?.enabled === true,
    address: data ? expenseEmailAddress(data.alias_token, domain) : null,
  };
}
