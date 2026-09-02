export const EXPENSE_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const ACCEPTED = {
  "application/pdf": { extension: "pdf", signature: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  "image/jpeg": { extension: "jpg", signature: [0xff, 0xd8, 0xff] },
  "image/png": { extension: "png", signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
} as const;

export type ExpenseReceiptMime = keyof typeof ACCEPTED;

export interface ExpenseReceiptValidation {
  ok: boolean;
  message: string;
  mimeType?: ExpenseReceiptMime;
  extension?: string;
}

export async function validateExpenseReceiptFile(file: File): Promise<ExpenseReceiptValidation> {
  if (file.size <= 0) return { ok: false, message: "El comprobante está vacío." };
  if (file.size > EXPENSE_RECEIPT_MAX_BYTES) return { ok: false, message: "El comprobante supera el máximo de 10 MB." };
  if (!(file.type in ACCEPTED)) return { ok: false, message: "Usa un archivo PDF, JPG o PNG." };

  const mimeType = file.type as ExpenseReceiptMime;
  const definition = ACCEPTED[mimeType];
  const header = new Uint8Array(await file.slice(0, definition.signature.length).arrayBuffer());
  const matches = definition.signature.every((byte, index) => header[index] === byte);
  if (!matches) return { ok: false, message: "El contenido del archivo no coincide con su formato declarado." };

  return { ok: true, message: "", mimeType, extension: definition.extension };
}
