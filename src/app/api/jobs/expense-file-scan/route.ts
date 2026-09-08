import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { runExpenseFileScanWorkerWithServiceRole } from "@/lib/expense-file-scan/service";
import { isAuthorizedExpenseFileScanCron } from "./route-utils";

export async function GET(request: NextRequest) {
  if (!isAuthorizedExpenseFileScanCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  if (process.env.EXPENSE_FILE_SCAN_ENABLED !== "true") {
    return NextResponse.json({ enabled: false, reason: "EXPENSE_FILE_SCAN_ENABLED is not true" });
  }
  try {
    const summary = await runExpenseFileScanWorkerWithServiceRole();
    return NextResponse.json({ enabled: true, ...summary });
  } catch {
    return NextResponse.json({ error: "Fallo interno procesando la cuarentena." }, { status: 500 });
  }
}
