import "server-only";
import type { NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";

export function isAuthorizedExpenseOcrCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}
