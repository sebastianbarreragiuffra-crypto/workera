import "server-only";

import {
  handleExpenseWhatsappVerification,
  handleExpenseWhatsappWebhook,
} from "./route-utils";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleExpenseWhatsappVerification(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleExpenseWhatsappWebhook(request);
}
