import "server-only";

import { handleExpenseEmailWebhook } from "./route-utils";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleExpenseEmailWebhook(request);
}
