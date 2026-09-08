import "server-only";
import type { NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";

export function isAuthorizedExpenseFileScanCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}
