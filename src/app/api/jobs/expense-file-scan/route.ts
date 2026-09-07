import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import { runExpenseFileScanWorkerWithServiceRole } from "@/lib/expense-file-scan/service";
import type { ExpenseFileScanWorkerSummary } from "@/lib/expense-file-scan/worker";

export const maxDuration = 60;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function expenseFileScanCronHttpStatus(summary: ExpenseFileScanWorkerSummary): number {
  return summary.failed > 0 ? 503 : 200;
}

export function isAuthorizedExpenseFileScanCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export async function GET(request: NextRequest) {
  const correlationId = randomUUID();
  if (!isAuthorizedExpenseFileScanCron(request)) {
    return json({ error: "No autorizado." }, 401);
  }
  if (process.env.EXPENSE_FILE_SCAN_ENABLED !== "true") {
    if (process.env.EXPENSE_FILE_SCAN_MONITOR_EXPECT_ENABLED === "true") {
      console.error("expense_file_scan_configuration_drift", { correlationId });
      return json({ enabled: false, error: "configuration_drift", correlationId }, 503);
    }
    return json({
      enabled: false,
      reason: "EXPENSE_FILE_SCAN_ENABLED is not true",
      correlationId,
    });
  }
  try {
    const summary = await runExpenseFileScanWorkerWithServiceRole();
    const status = expenseFileScanCronHttpStatus(summary);
    console.info("expense_file_scan_run", {
      correlationId,
      outcome: status === 200 ? "success" : "scan_failed",
      ...summary,
    });
    return json({
      enabled: true,
      ...(status === 503 ? { error: "scan_failed" } : {}),
      correlationId,
      ...summary,
    }, status);
  } catch (cause) {
    console.error("expense_file_scan_failed", {
      correlationId,
      errorName: cause instanceof Error ? cause.name : "UnknownError",
    });
    return json({ error: "Fallo interno procesando la cuarentena.", correlationId }, 500);
  }
}
