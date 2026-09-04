import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { runExpenseOcrWorkerWithServiceRole } from "@/lib/expense-ocr/service";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";

export function isAuthorizedExpenseOcrCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedExpenseOcrCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  if (process.env.EXPENSE_OCR_ENABLED !== "true") {
    return NextResponse.json({ enabled: false, reason: "EXPENSE_OCR_ENABLED is not true" });
  }
  try {
    const summary = await runExpenseOcrWorkerWithServiceRole();
    return NextResponse.json({ enabled: true, ...summary });
  } catch {
    return NextResponse.json({ error: "Fallo interno procesando la cola OCR." }, { status: 500 });
  }
}
