import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runExpenseAccountingOperationsWithServiceRole } from "@/lib/expense-accounting/service";
import { isExpenseAccountingExpectedActive } from "@/lib/expense-accounting/config";
import { expenseAccountingOperationalErrorCode } from "@/lib/expense-accounting/repository";
import {
  expenseAccountingCronHttpStatus,
  isAuthorizedExpenseAccountingCron,
} from "./route-utils";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedExpenseAccountingCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  const correlationId = randomUUID();
  try {
    const operations = await runExpenseAccountingOperationsWithServiceRole("CRON");
    if (!operations.enabled) {
      const expectedActive = isExpenseAccountingExpectedActive();
      return NextResponse.json(
        { enabled: false, expectedActive, reason: "EXPENSE_ACCOUNTING_EXPORT_ENABLED is not true", correlationId },
        { status: expectedActive ? 503 : 200 }
      );
    }
    const { result } = operations;
    return NextResponse.json(
      {
        enabled: true,
        mode: operations.provider,
        skipped: result.skipped,
        runId: result.runId,
        batches: result.batches,
        summary: result.summary,
        health: result.health,
        correlationId,
      },
      { status: expenseAccountingCronHttpStatus(result) }
    );
  } catch (error) {
    const errorCode = expenseAccountingOperationalErrorCode(error);
    console.error("[expense-accounting]", {
      event: "cron_failed",
      correlationId,
      errorCode,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Fallo interno procesando la cola contable.", errorCode, correlationId },
      { status: 500 }
    );
  }
}
