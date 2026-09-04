import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export function isAuthorizedExpenseOcrCron(request: NextRequest): boolean {
  const configured = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!configured || !header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(configured);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
