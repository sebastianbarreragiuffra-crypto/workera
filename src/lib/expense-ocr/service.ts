import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { AzureDocumentIntelligenceClient } from "./azure-document-intelligence";
import { readExpenseOcrConfig } from "./config";
import { SupabaseExpenseOcrRepository } from "./repository";
import { runExpenseOcrWorker, type ExpenseOcrWorkerSummary } from "./worker";

export async function runExpenseOcrWorkerWithServiceRole(): Promise<ExpenseOcrWorkerSummary> {
  const config = readExpenseOcrConfig();
  if (!config.enabled) return { reclaimed: 0, claimed: 0, completed: 0, deferred: 0, failed: 0, retried: 0 };
  const repository = new SupabaseExpenseOcrRepository(createAdminClient());
  const provider = new AzureDocumentIntelligenceClient(config);
  return runExpenseOcrWorker(repository, provider);
}
