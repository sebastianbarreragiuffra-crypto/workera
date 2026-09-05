import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { DryRunLedgerAdapter } from "./adapter";
import { readExpenseAccountingConfig, readExpenseAccountingWatchdogStaleSeconds } from "./config";
import {
  classifyExpenseAccountingHealth,
  runExpenseAccountingCatchUp,
  type ExpenseAccountingCatchUpResult,
  type ExpenseAccountingOperationsHealth,
} from "./orchestrator";
import type { ExpenseAccountingRunTrigger } from "./repository";
import { SupabaseExpenseAccountingRepository } from "./repository";
import type { ExpenseAccountingWorkerSummary } from "./worker";

export async function runExpenseAccountingWorkerWithServiceRole(): Promise<ExpenseAccountingWorkerSummary> {
  const result = await runExpenseAccountingOperationsWithServiceRole("AFTER_RESPONSE");
  return result.enabled ? result.result.summary : { claimed: 0, succeeded: 0, retried: 0, failed: 0 };
}

export type ExpenseAccountingOperationsResult =
  | { enabled: false; provider: "disabled" }
  | { enabled: true; provider: "dry-run"; result: ExpenseAccountingCatchUpResult };

export async function runExpenseAccountingOperationsWithServiceRole(
  trigger: ExpenseAccountingRunTrigger
): Promise<ExpenseAccountingOperationsResult> {
  const config = readExpenseAccountingConfig();
  if (!config.enabled) return { enabled: false, provider: "disabled" };
  const result = await runExpenseAccountingCatchUp(
    new SupabaseExpenseAccountingRepository(createAdminClient("expense-accounting-worker")),
    new DryRunLedgerAdapter(),
    trigger,
    config
  );
  return { enabled: true, provider: config.provider, result };
}

export type ExpenseAccountingHealthResult =
  | { enabled: false; provider: "disabled"; health: ExpenseAccountingOperationsHealth }
  | { enabled: true; provider: "dry-run"; health: ExpenseAccountingOperationsHealth };

export async function getExpenseAccountingHealthWithServiceRole(): Promise<ExpenseAccountingHealthResult> {
  const config = readExpenseAccountingConfig();
  const snapshot = await new SupabaseExpenseAccountingRepository(createAdminClient("expense-accounting-worker"))
    .getHealth(readExpenseAccountingWatchdogStaleSeconds());
  const health = classifyExpenseAccountingHealth(snapshot);
  return config.enabled
    ? { enabled: true, provider: config.provider, health }
    : { enabled: false, provider: "disabled", health };
}
