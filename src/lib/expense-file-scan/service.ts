import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { readExpenseFileScanConfig } from "./config";
import { SupabaseExpenseFileScanRepository } from "./repository";
import { FixtureExpenseFileScanner } from "./scanner";
import { runExpenseFileScanWorker, type ExpenseFileScanWorkerSummary } from "./worker";

const EMPTY_SUMMARY: ExpenseFileScanWorkerSummary = {
  reclaimed: 0,
  claimed: 0,
  clean: 0,
  rejected: 0,
  failed: 0,
  retried: 0,
};

export async function runExpenseFileScanWorkerWithServiceRole(): Promise<ExpenseFileScanWorkerSummary> {
  const config = readExpenseFileScanConfig();
  if (!config.enabled) return EMPTY_SUMMARY;

  const repository = new SupabaseExpenseFileScanRepository(
    createAdminClient("expense-file-scan-worker"),
  );
  // La configuración actual solo puede producir fixture fuera de producción.
  const scanner = new FixtureExpenseFileScanner();
  return runExpenseFileScanWorker(repository, scanner);
}
