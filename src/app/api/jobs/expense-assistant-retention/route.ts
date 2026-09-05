import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import { purgeExpiredExpenseAssistantQueriesWithServiceRole } from "@/lib/expense-assistant/service";

export const maxDuration = 30;

export function isAuthorizedExpenseAssistantRetentionCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export async function handleExpenseAssistantRetention(
  request: NextRequest,
  purge: () => Promise<number> = purgeExpiredExpenseAssistantQueriesWithServiceRole,
) {
  if (!isAuthorizedExpenseAssistantRetentionCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  const correlationId = randomUUID();
  try {
    const deleted = await purge();
    return NextResponse.json({ deleted, retentionDays: 90, correlationId });
  } catch (error) {
    console.error("[expense-assistant-retention]", {
      event: "retention_run_failed",
      correlationId,
      errorCode: "RETENTION_RUN_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "Fallo interno purgando el historial del asistente.",
        errorCode: "RETENTION_RUN_FAILED",
        correlationId,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleExpenseAssistantRetention(request);
}
