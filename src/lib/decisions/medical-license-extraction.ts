export type MedicalLicenseExtractionStatus = "EXTRAIDO" | "REQUIERE_REVISION";

export interface MedicalLicenseExtractionResult {
  status: MedicalLicenseExtractionStatus;
  proposedStartDate: string | null;
  proposedEndDate: string | null;
  proposedDays: number | null;
}

const EMPTY_RESULT: MedicalLicenseExtractionResult = {
  status: "REQUIERE_REVISION",
  proposedStartDate: null,
  proposedEndDate: null,
  proposedDays: null,
};

const DATE_CAPTURE = "(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})";

function normalizeDocumentText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toIsoDate(value: string): string | null {
  const parts = value.split(/[-/.]/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const [year, month, day] = parts[0] > 999 ? parts : [parts[2], parts[1], parts[0]];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function inclusiveDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Extracción deliberadamente conservadora. No es OCR: reutiliza solo texto
 * que ya esté embebido en el documento y exige etiquetas explícitas para no
 * confundir fechas de emisión, nacimiento u otras fechas del certificado.
 */
export function extractMedicalLicenseDates(fileBytes: Uint8Array): MedicalLicenseExtractionResult {
  const rawText = new TextDecoder("latin1").decode(fileBytes);
  const text = normalizeDocumentText(rawText);
  const startMatch = text.match(new RegExp(`(?:fecha de inicio|inicio|desde)\\s*[:.-]?\\s*${DATE_CAPTURE}`, "i"));
  const endMatch = text.match(new RegExp(`(?:fecha de termino|termino|hasta)\\s*[:.-]?\\s*${DATE_CAPTURE}`, "i"));
  if (!startMatch?.[1] || !endMatch?.[1]) return EMPTY_RESULT;

  const proposedStartDate = toIsoDate(startMatch[1]);
  const proposedEndDate = toIsoDate(endMatch[1]);
  if (!proposedStartDate || !proposedEndDate || proposedEndDate < proposedStartDate) return EMPTY_RESULT;

  const proposedDays = inclusiveDays(proposedStartDate, proposedEndDate);
  if (proposedDays < 1 || proposedDays > 365) return EMPTY_RESULT;

  const statedDays = text.match(/(?:numero de dias|cantidad de dias|dias de licencia)\s*[:.-]?\s*(\d{1,3})/i)?.[1];
  if (statedDays && Number(statedDays) !== proposedDays) return EMPTY_RESULT;

  return { status: "EXTRAIDO", proposedStartDate, proposedEndDate, proposedDays };
}
