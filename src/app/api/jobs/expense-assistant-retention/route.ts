import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import { purgeExpiredExpenseAssistantQueriesWithServiceRole } from "@/lib/expense-assistant/service";

export const maxDuration = 30;

export function isAuthorizedExpenseAssistantRetentionCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedExpenseAssistantRetentionCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  try {
    const deleted = await purgeExpiredExpenseAssistantQueriesWithServiceRole();
    return NextResponse.json({ deleted, retentionDays: 90 });
  } catch {
    return NextResponse.json({ error: "Fallo interno purgando el historial del asistente." }, { status: 500 });
  }
}
