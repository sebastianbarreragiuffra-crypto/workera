import "server-only";

import * as XLSX from "xlsx";
import type { ProductionMealDiscountDataset, ProductionMealDiscountRecord } from "./types";
import { getProductionMealPricing } from "./pricing";

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    const localMatch = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(trimmed);
    if (localMatch) return `${localMatch[3]}-${localMatch[2].padStart(2, "0")}-${localMatch[1].padStart(2, "0")}`;
  }
  return null;
}

function normalizeHeader(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    : "";
}

function toAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[^\d-]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function mondayFor(dateIso: string): string {
  const date = new Date(`${dateIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function productionBillingCycleFor(dateIso: string) {
  const reference = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(reference.getTime())) throw new Error(`Fecha inválida para el ciclo de colaciones: ${dateIso}`);
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 15, 12));
  if (reference.getUTCDate() < 15) start.setUTCMonth(start.getUTCMonth() - 1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const monthLabel = (date: Date) => new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    name: `15 ${monthLabel(start)}–15 ${monthLabel(end)}`,
  };
}

export function parseProductionMealDiscountRows(rows: unknown[][]): ProductionMealDiscountRecord[] {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes("nombre") && headers.includes("fecha") && headers.includes("monto");
  });
  if (headerRowIndex < 0) throw new Error("El Excel debe incluir las columnas Nombre, Fecha y Monto.");

  const headers = rows[headerRowIndex].map(normalizeHeader);
  const nameColumn = headers.indexOf("nombre");
  const dateColumn = headers.indexOf("fecha");
  const amountColumn = headers.indexOf("monto");
  const records: ProductionMealDiscountRecord[] = [];
  let currentWorker = "";

  for (const row of rows.slice(headerRowIndex + 1)) {
    const nameValue = row[nameColumn];
    if (typeof nameValue === "string" && nameValue.trim()) currentWorker = nameValue.trim();

    const date = toIsoDate(row[dateColumn]);
    const sourceAmount = toAmount(row[amountColumn]);
    if (!currentWorker || !date || sourceAmount === null || sourceAmount <= 0) continue;
    const pricing = getProductionMealPricing(date, sourceAmount);
    records.push({
      workerName: currentWorker,
      area: "PRODUCCIÓN",
      date,
      weekStart: mondayFor(date),
      amount: pricing.amount,
      sourceAmount,
      priceKind: pricing.kind,
      orderDetail: null,
    });
  }

  records.sort((a, b) => a.date.localeCompare(b.date) || a.workerName.localeCompare(b.workerName, "es"));
  return records;
}

/**
 * Construye el dataset a partir de bytes YA EN MEMORIA -- nunca lee del
 * filesystem. Antes esto vivía inline dentro de una función que leía
 * `DESCUENTO DE COLACIONES.xlsx` del disco local (`process.cwd()`); ese
 * archivo está en `.gitignore` y nunca viaja con el despliegue, así que la
 * lectura fallaba siempre fuera de esta máquina (bloqueador real de Vercel).
 * Ahora los bytes vienen de Supabase Storage (ver
 * `discount-workbook-storage.ts`) -- la interpretación de negocio (parseo,
 * ciclo de facturación, pricing) es EXACTAMENTE la misma, sin cambios.
 */
export function buildProductionMealDiscountDataset(bytes: Uint8Array, sourceFileLabel: string): ProductionMealDiscountDataset {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: true });
  const detailSheet = workbook.Sheets.Hoja1;
  if (!detailSheet) throw new Error("El Excel no contiene la hoja Hoja1 esperada.");

  const rows = XLSX.utils.sheet_to_json<unknown[]>(detailSheet, { header: 1, raw: true, defval: null });
  const parsedRecords = parseProductionMealDiscountRows(rows);
  const dates = parsedRecords.map((record) => record.date).sort();
  if (!dates.length) throw new Error("El Excel no contiene descuentos válidos de Producción.");
  const cycle = productionBillingCycleFor(dates[0]);
  const records = parsedRecords.filter((record) => record.date >= cycle.start && record.date <= cycle.end);

  return {
    sourceFile: sourceFileLabel,
    cycleName: cycle.name,
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    records,
    registeredAmounts: [...new Set(records.map((record) => record.amount))].sort((a, b) => b - a),
    pricingMismatchCount: records.filter((record) => record.sourceAmount !== record.amount).length,
  };
}
