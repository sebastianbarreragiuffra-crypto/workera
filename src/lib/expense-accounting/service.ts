import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { DryRunLedgerAdapter } from "./adapter";
import { readExpenseAccountingConfig } from "./config";
import { SupabaseExpenseAccountingRepository } from "./repository";
import { runExpenseAccountingWorker, type ExpenseAccountingWorkerSummary } from "./worker";

export async function runExpenseAccountingWorkerWithServiceRole(): Promise<ExpenseAccountingWorkerSummary> {
  const config = readExpenseAccountingConfig();
  if (!config.enabled) return { claimed: 0, succeeded: 0, retried: 0, failed: 0 };
  return runExpenseAccountingWorker(
    new SupabaseExpenseAccountingRepository(createAdminClient()),
    new DryRunLedgerAdapter()
  );
}
