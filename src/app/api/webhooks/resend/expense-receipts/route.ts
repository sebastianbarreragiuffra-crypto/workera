import "server-only";

import { NextResponse } from "next/server";
import { Resend, type EmailReceivedEvent, type WebhookEventPayload } from "resend";
import { getExpenseEmailProviderConfig, type ExpenseEmailProviderConfig } from "@/lib/expense-email/config";
import { processResendExpenseEmail, type ExpenseEmailProcessSummary } from "@/lib/expense-email/service";

export const runtime = "nodejs";
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

interface ExpenseEmailWebhookDependencies {
  config: () => ExpenseEmailProviderConfig | null;
  verify: (input: {
    rawBody: string;
    id: string;
    timestamp: string;
    signature: string;
    config: ExpenseEmailProviderConfig;
  }) => WebhookEventPayload;
  process: (
    event: EmailReceivedEvent,
    config: ExpenseEmailProviderConfig,
    providerEventId: string
  ) => Promise<ExpenseEmailProcessSummary>;
}

const defaultDependencies: ExpenseEmailWebhookDependencies = {
  config: getExpenseEmailProviderConfig,
  verify: ({ rawBody, id, timestamp, signature, config }) => new Resend(config.apiKey).webhooks.verify({
    payload: rawBody,
    headers: { id, timestamp, signature },
    webhookSecret: config.webhookSecret,
  }),
  process: processResendExpenseEmail,
};

export async function readRequestBodyLimited(
  request: Request,
  maxBytes = MAX_WEBHOOK_BODY_BYTES
): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

export async function handleExpenseEmailWebhook(
  request: Request,
  dependencies: ExpenseEmailWebhookDependencies = defaultDependencies
): Promise<Response> {
  const config = dependencies.config();
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Recepción por correo no disponible." }, { status: 503 });
  }

  const id = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return NextResponse.json({ error: "Firma requerida." }, { status: 401 });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ error: "Solicitud demasiado grande." }, { status: 413 });
    }
  }

  let event: WebhookEventPayload;
  try {
    const rawBody = await readRequestBodyLimited(request);
    if (rawBody === null) {
      return NextResponse.json({ error: "Solicitud demasiado grande." }, { status: 413 });
    }
    event = dependencies.verify({ rawBody, id, timestamp, signature, config });
  } catch {
    return NextResponse.json({ error: "Firma inválida." }, { status: 401 });
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ accepted: true, ignored: true }, { status: 202 });
  }

  try {
    const result = await dependencies.process(event, config, id);
    return NextResponse.json({ accepted: true, ...result });
  } catch {
    // Resend reintentará las respuestas 5xx. No incluimos remitentes,
    // destinatarios, URLs firmadas ni secretos en la respuesta o logs.
    return NextResponse.json({ error: "No se pudo procesar el correo." }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleExpenseEmailWebhook(request);
}
