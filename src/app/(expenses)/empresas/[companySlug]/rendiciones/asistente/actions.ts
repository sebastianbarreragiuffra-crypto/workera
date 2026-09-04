"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import {
  ExpenseAssistantRateLimitError,
  parseExpenseAssistantIntent,
  parseExpenseAssistantWindow,
  runExpenseAssistantQuery,
} from "@/lib/expenses/assistant";
import { createClient } from "@/lib/supabase/server";

const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63);

function pagePath(companySlug: string): string {
  return `/empresas/${companySlug}/rendiciones/asistente`;
}

export async function runExpenseAssistantAction(formData: FormData): Promise<never> {
  const companySlug = slugSchema.safeParse(formData.get("companySlug"));
  const intent = parseExpenseAssistantIntent(formData.get("intent"));
  const windowDays = parseExpenseAssistantWindow(formData.get("windowDays"));
  if (!companySlug.success || !intent || !windowDays) redirect("/rendiciones");

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug.data);
  if (!context) redirect("/rendiciones");

  let queryId: string;
  try {
    queryId = await runExpenseAssistantQuery(supabase, context, intent, windowDays);
  } catch (error) {
    const code = error instanceof ExpenseAssistantRateLimitError ? "limite" : "operacion";
    redirect(`${pagePath(context.slug)}?error=${code}`);
  }

  redirect(`${pagePath(context.slug)}?consulta=${queryId}`);
}
