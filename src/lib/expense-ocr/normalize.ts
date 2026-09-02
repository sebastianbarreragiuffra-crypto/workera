import "server-only";
import type { AzureAnalyzeResponse, AzureDocumentField } from "./azure-document-intelligence";

export interface DeclaredExpense {
  expenseDate: string;
  merchantName: string | null;
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
  currencyCode: string;
}

export interface NormalizedOcrField<T> {
  value: T | null;
  confidence: number | null;
}

export interface ExpenseOcrExtraction {
  schemaVersion: 1;
  provider: "azure-document-intelligence";
  modelId: "prebuilt-receipt";
  fields: {
    merchantName: NormalizedOcrField<string>;
    transactionDate: NormalizedOcrField<string>;
    subtotal: NormalizedOcrField<number>;
    totalTax: NormalizedOcrField<number>;
    total: NormalizedOcrField<number>;
    currencyCode: NormalizedOcrField<string>;
  };
  confidence: number | null;
  discrepancies: Array<{ field: string; declared: string | number | null; extracted: string | number | null }>;
  reviewReasons: string[];
  requiresHumanReview: boolean;
}

const LOW_CONFIDENCE = 0.8;

function confidence(field?: AzureDocumentField): number | null {
  return typeof field?.confidence === "number" ? Math.max(0, Math.min(1, field.confidence)) : null;
}

function text(field?: AzureDocumentField): NormalizedOcrField<string> {
  const value = field?.valueString ?? field?.content?.trim() ?? null;
  return { value: value || null, confidence: confidence(field) };
}

function date(field?: AzureDocumentField): NormalizedOcrField<string> {
  const value = field?.valueDate ?? null;
  return { value: value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null, confidence: confidence(field) };
}

function money(field?: AzureDocumentField): NormalizedOcrField<number> {
  const value = field?.valueCurrency?.amount ?? field?.valueNumber;
  return { value: typeof value === "number" && Number.isFinite(value) ? value : null, confidence: confidence(field) };
}

function canonicalText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function amountsDiffer(declared: number, extracted: number, currency: string): boolean {
  return Math.abs(declared - extracted) > (currency === "CLP" ? 1 : 0.01);
}

export function normalizeAzureReceipt(
  response: AzureAnalyzeResponse,
  declared: DeclaredExpense
): ExpenseOcrExtraction {
  const source = response.analyzeResult?.documents?.[0]?.fields ?? {};
  const merchantName = text(source.MerchantName);
  const transactionDate = date(source.TransactionDate);
  const subtotal = money(source.Subtotal);
  const totalTax = money(source.TotalTax);
  const total = money(source.Total);
  const currencyValue = source.Total?.valueCurrency?.currencyCode?.toUpperCase() ?? null;
  const currencyCode: NormalizedOcrField<string> = {
    value: currencyValue,
    confidence: confidence(source.Total),
  };

  const fields = { merchantName, transactionDate, subtotal, totalTax, total, currencyCode };
  const discrepancies: ExpenseOcrExtraction["discrepancies"] = [];
  if (merchantName.value && declared.merchantName && canonicalText(merchantName.value) !== canonicalText(declared.merchantName)) {
    discrepancies.push({ field: "merchantName", declared: declared.merchantName, extracted: merchantName.value });
  }
  if (transactionDate.value && transactionDate.value !== declared.expenseDate) {
    discrepancies.push({ field: "expenseDate", declared: declared.expenseDate, extracted: transactionDate.value });
  }
  if (subtotal.value !== null && amountsDiffer(declared.netAmount, subtotal.value, declared.currencyCode)) {
    discrepancies.push({ field: "netAmount", declared: declared.netAmount, extracted: subtotal.value });
  }
  if (totalTax.value !== null && amountsDiffer(declared.taxAmount, totalTax.value, declared.currencyCode)) {
    discrepancies.push({ field: "taxAmount", declared: declared.taxAmount, extracted: totalTax.value });
  }
  if (total.value !== null && amountsDiffer(declared.totalAmount, total.value, declared.currencyCode)) {
    discrepancies.push({ field: "totalAmount", declared: declared.totalAmount, extracted: total.value });
  }
  if (currencyCode.value && currencyCode.value !== declared.currencyCode) {
    discrepancies.push({ field: "currencyCode", declared: declared.currencyCode, extracted: currencyCode.value });
  }

  const reviewReasons: string[] = [];
  for (const [name, field] of Object.entries({ merchantName, transactionDate, total, currencyCode })) {
    if (field.value === null) reviewReasons.push(`missing:${name}`);
  }
  const availableConfidences = Object.values(fields)
    .map((field) => field.confidence)
    .filter((value): value is number => value !== null);
  const overallConfidence = availableConfidences.length
    ? availableConfidences.reduce((sum, value) => sum + value, 0) / availableConfidences.length
    : null;
  if (overallConfidence === null || overallConfidence < LOW_CONFIDENCE) reviewReasons.push("low-confidence");
  if (discrepancies.length) reviewReasons.push("declared-data-discrepancy");

  return {
    schemaVersion: 1,
    provider: "azure-document-intelligence",
    modelId: "prebuilt-receipt",
    fields,
    confidence: overallConfidence,
    discrepancies,
    reviewReasons,
    requiresHumanReview: reviewReasons.length > 0,
  };
}
