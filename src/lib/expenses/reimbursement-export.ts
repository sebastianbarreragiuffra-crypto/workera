import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseCompanyContext } from "./access";
import type { Database } from "@/lib/supabase/database.types";
import { santiagoDayStartIso } from "@/lib/shared/date-time";
import { unwrapEmbed } from "@/lib/supabase/embed";
import { formatExpenseMoney } from "./presentation";

/**
 * Planilla mensual de reembolso: cuánto hay que devolverle a cada persona
 * por gastos que pagó con su tarjeta personal, agrupado por moneda (nunca se
 * suman montos de monedas distintas en una misma fila). Incluye APPROVED
 * (pendiente de pago) y PAID (ya pagadas dentro del mes) -- el objetivo es
 * un consolidado del mes, no solo la cola de conciliación pendiente.
 */
const REIMBURSABLE_STATUSES = ["APPROVED", "PAID"] as const;

/** "2026-09" -> ["2026-09-01", "2026-10-01") en el día calendario de Santiago. */
export function monthBounds(month: string): { startDate: string; nextMonthStartDate: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new RangeError(`Mes inválido: ${month} (formato esperado YYYY-MM)`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new RangeError(`Mes inválido: ${month}`);

  const startDate = `${match[1]}-${match[2]}-01`;
  const nextMonthDate = new Date(Date.UTC(year, monthIndex + 1, 1));
  const nextMonthStartDate = nextMonthDate.toISOString().slice(0, 10);
  return { startDate, nextMonthStartDate };
}

export interface ReimbursementRow {
  employeeName: string;
  currencyCode: string;
  totalAmount: number;
  reportCount: number;
  referenceNumbers: string[];
}

export interface ReimbursementExportData {
  companyName: string;
  month: string;
  rows: ReimbursementRow[];
}

export async function buildReimbursementExportData(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  month: string
): Promise<ReimbursementExportData> {
  const { startDate, nextMonthStartDate } = monthBounds(month);

  const { data, error } = await supabase
    .from("expense_reports")
    .select("reference_number, currency_code, total_amount, submitted_by, profiles!expense_reports_submitted_by_fkey(display_name)")
    .eq("company_id", context.id)
    .in("status", REIMBURSABLE_STATUSES)
    .gte("submitted_at", santiagoDayStartIso(startDate))
    .lt("submitted_at", santiagoDayStartIso(nextMonthStartDate));
  if (error) throw new Error("No se pudo generar la planilla de reembolsos.");

  // Agrupado por (persona, moneda): nunca se mezclan montos de monedas
  // distintas en un mismo total.
  const groups = new Map<string, ReimbursementRow>();
  for (const report of data ?? []) {
    const profile = unwrapEmbed(report.profiles);
    const employeeName = profile?.display_name ?? "Persona sin nombre registrado";
    const key = `${report.submitted_by}::${report.currency_code}`;
    const existing = groups.get(key);
    if (existing) {
      existing.totalAmount += Number(report.total_amount);
      existing.reportCount += 1;
      existing.referenceNumbers.push(report.reference_number);
    } else {
      groups.set(key, {
        employeeName,
        currencyCode: report.currency_code,
        totalAmount: Number(report.total_amount),
        reportCount: 1,
        referenceNumbers: [report.reference_number],
      });
    }
  }

  const rows = [...groups.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName, "es") || a.currencyCode.localeCompare(b.currencyCode));
  return { companyName: context.name, month, rows };
}

export function buildReimbursementExportWorkbook(data: ReimbursementExportData): Uint8Array {
  const header = [
    [`Reembolsos de ${data.companyName} -- ${data.month}`],
    ["Rendiciones aprobadas o pagadas con comprobantes pagados por la persona, enviadas dentro del mes"],
    [],
    ["Persona", "Moneda", "Total a reembolsar", "Rendiciones", "Folios"],
  ];
  const body = data.rows.map((row) => [
    row.employeeName,
    row.currencyCode,
    row.totalAmount,
    row.reportCount,
    row.referenceNumbers.join(", "),
  ]);
  const totalsByCurrency = new Map<string, number>();
  for (const row of data.rows) totalsByCurrency.set(row.currencyCode, (totalsByCurrency.get(row.currencyCode) ?? 0) + row.totalAmount);
  const footer = [[], ...[...totalsByCurrency].map(([currencyCode, total]) => ["Total", currencyCode, formatExpenseMoney(total, currencyCode)])];

  const sheet = XLSX.utils.aoa_to_sheet([...header, ...body, ...footer]);
  sheet["!cols"] = [{ wch: 28 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 40 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Reembolsos");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
