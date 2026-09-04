import { z } from "zod";
import type { Json } from "@/lib/supabase/database.types";

const money = z.union([z.number(), z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/)]).transform(Number)
  .refine((value) => Number.isFinite(value) && value >= 0 && value <= 999_999_999_999.99);
const safeText = z.string().min(1).max(240);

const accountingPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("LEDGER_CSV_V1"),
  company: z.object({ id: z.string().uuid(), name: safeText }).strict(),
  report: z.object({
    id: z.string().uuid(),
    referenceNumber: safeText,
    title: safeText,
    currency: z.string().regex(/^[A-Z]{3}$/),
    totalAmount: money,
    paidAt: z.iso.datetime({ offset: true }),
    paymentReference: z.string().min(1).max(160),
    submitterId: z.string().uuid(),
    submitterName: safeText,
    costCenterCode: z.string().max(80).nullable(),
    costCenterName: z.string().max(160).nullable(),
  }).strict(),
  lines: z.array(z.object({
    itemId: z.string().uuid(),
    expenseDate: z.iso.date(),
    categoryCode: z.string().min(1).max(40),
    categoryName: safeText,
    merchant: z.string().max(160).nullable(),
    description: safeText,
    netAmount: money,
    taxAmount: money,
    totalAmount: money,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict()).min(1).max(2_000),
}).strict();

export type ExpenseAccountingPayload = z.infer<typeof accountingPayloadSchema>;

function sameMoney(left: number, right: number): boolean {
  return Math.abs(Math.round(left * 100) - Math.round(right * 100)) === 0;
}

/**
 * Valida el snapshot incluso si vino desde una tabla privilegiada: ningún
 * adapter recibe un contrato incompleto, moneda mezclada o total alterado.
 */
export function parseExpenseAccountingPayload(value: Json): ExpenseAccountingPayload {
  const payload = accountingPayloadSchema.parse(value);
  let total = 0;
  for (const line of payload.lines) {
    if (line.currency !== payload.report.currency || !sameMoney(line.netAmount + line.taxAmount, line.totalAmount)) {
      throw new Error("Snapshot contable inconsistente.");
    }
    total += line.totalAmount;
  }
  if (!sameMoney(total, payload.report.totalAmount)) throw new Error("Snapshot contable inconsistente.");
  return payload;
}
