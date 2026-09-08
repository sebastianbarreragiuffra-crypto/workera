import "server-only";
import type { NextRequest } from "next/server";
import { handleExpenseAccountingWatchdog } from "./route-utils";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  return handleExpenseAccountingWatchdog(request);
}
