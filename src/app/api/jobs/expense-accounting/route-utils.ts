import "server-only";
import type { NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import type { ExpenseAccountingCatchUpResult } from "@/lib/expense-accounting/orchestrator";

export function isAuthorizedExpenseAccountingCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export function expenseAccountingCronHttpStatus(result: ExpenseAccountingCatchUpResult): number {
  // Una entrega solapada puede omitirse, pero nunca debe ocultar una DLQ o
  // lease vencido al monitor que observa este mismo endpoint.
  if (result.health.status === "CRITICAL") return 503;
  return result.skipped ? 202 : 200;
}
