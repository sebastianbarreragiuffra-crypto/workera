import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import {
  getExpenseAccountingHealthWithServiceRole,
  type ExpenseAccountingHealthResult,
} from "@/lib/expense-accounting/service";
import type { ExpenseAccountingHealthStatus } from "@/lib/expense-accounting/orchestrator";
import { isExpenseAccountingExpectedActive } from "@/lib/expense-accounting/config";
import { expenseAccountingOperationalErrorCode } from "@/lib/expense-accounting/repository";

export const maxDuration = 30;

export function isAuthorizedExpenseAccountingWatchdog(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export function expenseAccountingWatchdogHttpStatus(status: ExpenseAccountingHealthStatus): number {
  return status === "CRITICAL" ? 503 : 200;
}

export function expenseAccountingPausedWatchdogHttpStatus(
  expectedActive: boolean,
  operations: ExpenseAccountingHealthResult
): number {
  return expectedActive
    || operations.health.failedCount > 0
    || operations.health.staleProcessingCount > 0
    || operations.health.lastRunStatus === "FAILED"
    ? 503
    : 200;
}

export async function handleExpenseAccountingWatchdog(
  request: NextRequest,
  readHealth: () => Promise<ExpenseAccountingHealthResult> = getExpenseAccountingHealthWithServiceRole
) {
  if (!isAuthorizedExpenseAccountingWatchdog(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  const correlationId = randomUUID();
  try {
    const operations = await readHealth();
    if (!operations.enabled) {
      const expectedActive = isExpenseAccountingExpectedActive();
      return NextResponse.json(
        {
          enabled: false,
          expectedActive,
          reason: "EXPENSE_ACCOUNTING_EXPORT_ENABLED is not true",
          health: operations.health,
          correlationId,
        },
        { status: expenseAccountingPausedWatchdogHttpStatus(expectedActive, operations) }
      );
    }
    return NextResponse.json(
      { enabled: true, mode: operations.provider, health: operations.health, correlationId },
      { status: expenseAccountingWatchdogHttpStatus(operations.health.status) }
    );
  } catch (error) {
    const errorCode = expenseAccountingOperationalErrorCode(error);
    console.error("[expense-accounting]", {
      event: "watchdog_failed",
      correlationId,
      errorCode,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Fallo interno consultando la salud contable.", errorCode, correlationId },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return handleExpenseAccountingWatchdog(request);
}
