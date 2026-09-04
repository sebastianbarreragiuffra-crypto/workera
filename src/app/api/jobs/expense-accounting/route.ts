import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import { runExpenseAccountingWorkerWithServiceRole } from "@/lib/expense-accounting/service";

export const maxDuration = 60;

export function isAuthorizedExpenseAccountingCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedExpenseAccountingCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  if (process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED !== "true") {
    return NextResponse.json({ enabled: false, reason: "EXPENSE_ACCOUNTING_EXPORT_ENABLED is not true" });
  }
  try {
    const summary = await runExpenseAccountingWorkerWithServiceRole();
    return NextResponse.json({ enabled: true, mode: "dry-run", ...summary });
  } catch {
    return NextResponse.json({ error: "Fallo interno procesando la cola contable." }, { status: 500 });
  }
}
