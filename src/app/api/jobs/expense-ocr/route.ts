import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runExpenseOcrWorkerWithServiceRole } from "@/lib/expense-ocr/service";

export function isAuthorizedExpenseOcrCron(request: NextRequest): boolean {
  const configured = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!configured || !header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(configured);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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
