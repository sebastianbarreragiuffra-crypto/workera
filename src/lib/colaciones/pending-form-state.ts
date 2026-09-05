import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import type { WeeklyMealGoogleFormPayload } from "./google-forms-payload";
import type { ParsedMealMenu } from "./menu-docx";

const TOKEN_VERSION = "v1";
const TOKEN_CONTEXT = "gestora:colaciones:google-form-retry:v1";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_PLAINTEXT_BYTES = 128 * 1024;
const MAX_TOKEN_CHARS = 192 * 1024;
const MIN_SECRET_CHARS = 32;

const daySchema = z.enum(["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES"]);
const boundedText = z.string().trim().min(1).max(500);

const menuSchema = z.object({
  title: z.string().trim().min(1).max(240),
  days: z.array(z.object({
    day: daySchema,
    menuOptions: z.array(boundedText).min(1).max(50),
    accompaniments: z.array(boundedText).max(30),
    extra: z.string().trim().max(500).nullable(),
  }).strict()).min(1).max(5),
  omittedDays: z.array(daySchema).max(5),
}).strict();

const payloadSchema = z.object({
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(1_000),
  closeAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/),
  reminderAfterHours: z.number().int().min(0).max(168),
  employeeNames: z.array(z.string().trim().min(1).max(160)).min(1).max(500),
  omittedDays: z.array(daySchema).max(5),
  questions: z.array(z.object({
    title: daySchema,
    options: z.array(boundedText).min(1).max(80),
  }).strict()).min(1).max(5),
}).strict();

const envelopeSchema = z.object({
  version: z.literal(1),
  expiresAt: z.number().int().positive(),
  fileName: z.string().trim().min(1).max(240),
  payload: payloadSchema,
  menu: menuSchema,
}).strict();

export interface PendingMealFormState {
  fileName: string;
  payload: WeeklyMealGoogleFormPayload;
  menu: ParsedMealMenu;
}

interface PendingStateOptions {
  /** Solo para pruebas; producción siempre usa GOOGLE_FORMS_SHARED_SECRET. */
  secret?: string;
  /** Solo para pruebas deterministas. */
  nowMs?: number;
  /** Solo para pruebas; producción usa 30 minutos. */
  ttlMs?: number;
}

export class PendingMealFormStateError extends Error {
  constructor() {
    super("El estado pendiente no es válido o ya venció.");
    this.name = "PendingMealFormStateError";
  }
}

function resolveSecret(override?: string): string {
  const secret = (override ?? process.env.GOOGLE_FORMS_SHARED_SECRET ?? "").trim();
  if (secret.length < MIN_SECRET_CHARS) throw new PendingMealFormStateError();
  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256")
    .update(TOKEN_CONTEXT)
    .update("\0")
    .update(secret)
    .digest();
}

function decodeTokenPart(value: string, maxBytes: number): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new PendingMealFormStateError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.byteLength > maxBytes) throw new PendingMealFormStateError();
  return decoded;
}

/**
 * Sella el menú y el payload en un token opaco autenticado. El navegador solo
 * recibe ciphertext: no puede leer la nómina ni alterar requestId/opciones.
 */
export function sealPendingMealFormState(
  state: PendingMealFormState,
  options: PendingStateOptions = {},
): string {
  try {
    const nowMs = options.nowMs ?? Date.now();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS) {
      throw new PendingMealFormStateError();
    }

    const envelope = envelopeSchema.parse({
      version: 1,
      expiresAt: nowMs + ttlMs,
      ...state,
    });
    const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new PendingMealFormStateError();

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(resolveSecret(options.secret)), iv);
    cipher.setAAD(Buffer.from(TOKEN_CONTEXT, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [TOKEN_VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), authTag.toString("base64url")].join(".");
  } catch (error) {
    if (error instanceof PendingMealFormStateError) throw error;
    throw new PendingMealFormStateError();
  }
}

/** Abre un token sellado, valida forma/tamaño y lo rechaza al vencer. */
export function openPendingMealFormState(
  token: string,
  options: PendingStateOptions = {},
): PendingMealFormState {
  try {
    if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) throw new PendingMealFormStateError();
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) throw new PendingMealFormStateError();

    const iv = decodeTokenPart(parts[1], 12);
    const ciphertext = decodeTokenPart(parts[2], MAX_PLAINTEXT_BYTES);
    const authTag = decodeTokenPart(parts[3], 16);
    if (iv.byteLength !== 12 || authTag.byteLength !== 16) throw new PendingMealFormStateError();

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(resolveSecret(options.secret)), iv);
    decipher.setAAD(Buffer.from(TOKEN_CONTEXT, "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new PendingMealFormStateError();

    const envelope = envelopeSchema.parse(JSON.parse(plaintext.toString("utf8")));
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || envelope.expiresAt <= nowMs) throw new PendingMealFormStateError();

    return {
      fileName: envelope.fileName,
      payload: envelope.payload,
      menu: envelope.menu,
    };
  } catch (error) {
    if (error instanceof PendingMealFormStateError) throw error;
    throw new PendingMealFormStateError();
  }
}
