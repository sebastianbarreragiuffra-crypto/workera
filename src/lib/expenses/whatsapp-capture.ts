import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { ExpenseCompanyContext } from "./access";
import { getExpenseWhatsappProviderConfig } from "@/lib/expense-whatsapp/config";

export interface ExpenseWhatsappConnectorDto {
  configured: boolean;
  enabled: boolean;
  paired: boolean;
  businessNumber: string | null;
}

export async function getExpenseWhatsappConnector(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<ExpenseWhatsappConnectorDto> {
  const config = getExpenseWhatsappProviderConfig();
  if (!config) return { configured: false, enabled: false, paired: false, businessNumber: null };

  const { data, error } = await supabase
    .from("expense_receipt_whatsapp_links")
    .select("active")
    .eq("company_id", context.id)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw new Error("No pudimos cargar la vinculación de WhatsApp.");

  return {
    configured: true,
    enabled: config.enabled,
    paired: data?.active === true,
    businessNumber: config.businessNumber,
  };
}
