import "server-only";

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getExpenseWhatsappProviderConfig, type ExpenseWhatsappProviderConfig } from "@/lib/expense-whatsapp/config";
import { processMetaExpenseWhatsapp, verifyMetaWebhookSignature, type ExpenseWhatsappProcessSummary } from "@/lib/expense-whatsapp/service";

export const runtime = "nodejs";
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;

interface Dependencies {
  config: () => ExpenseWhatsappProviderConfig | null;
  verify: (body: Uint8Array, signature: string | null, secret: string) => boolean;
  process: (payload: unknown, config: ExpenseWhatsappProviderConfig) => Promise<ExpenseWhatsappProcessSummary>;
}

const defaults: Dependencies = {
  config: getExpenseWhatsappProviderConfig,
  verify: verifyMetaWebhookSignature,
  process: processMetaExpenseWhatsapp,
};

function sameSecret(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
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
  return combined;
}

export async function handleExpenseWhatsappVerification(
  request: Request,
  dependencies: Dependencies = defaults
): Promise<Response> {
  const config = dependencies.config();
  // Meta necesita completar este desafío antes de que el canal pueda activarse.
  // Tener secretos válidos permite verificar el callback; solo POST depende del
  // interruptor operativo `enabled`.
  if (!config) return new Response("No disponible", { status: 503 });
  const url = new URL(request.url);
  if (url.searchParams.get("hub.mode") !== "subscribe"
    || !sameSecret(url.searchParams.get("hub.verify_token"), config.verifyToken)) {
    return new Response("No autorizado", { status: 403 });
  }
  const challenge = url.searchParams.get("hub.challenge");
  if (!challenge || !/^\d{1,32}$/.test(challenge)) return new Response("Solicitud inválida", { status: 400 });
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function handleExpenseWhatsappWebhook(
  request: Request,
  dependencies: Dependencies = defaults
): Promise<Response> {
  const config = dependencies.config();
  if (!config || !config.enabled) {
    return NextResponse.json({ error: "Recepción por WhatsApp no disponible." }, { status: 503 });
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0 || size > MAX_WEBHOOK_BODY_BYTES) {
      return NextResponse.json({ error: "Solicitud demasiado grande." }, { status: 413 });
    }
  }
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Solicitud demasiado grande." }, { status: 413 });
  if (!dependencies.verify(body, request.headers.get("x-hub-signature-256"), config.appSecret)) {
    return NextResponse.json({ error: "Firma inválida." }, { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 }); }

  try {
    return NextResponse.json({ accepted: true, ...await dependencies.process(payload, config) });
  } catch {
    // Meta reintenta respuestas 5xx. No exponemos wa_id, IDs de mensajes,
    // URLs temporales, tokens ni contenido en la respuesta o en logs.
    return NextResponse.json({ error: "No se pudo procesar el mensaje." }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  return handleExpenseWhatsappVerification(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleExpenseWhatsappWebhook(request);
}
