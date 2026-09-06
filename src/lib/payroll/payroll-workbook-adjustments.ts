import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export const PAYROLL_ADJUSTMENT_FIELDS = [
  "Ajuste HH50 (minutos)",
  "Motivo ajuste HH50",
  "Ajuste HH100 (minutos)",
  "Motivo ajuste HH100",
  "Ajuste bono (CLP)",
  "Motivo ajuste bono",
  "Código asistencia",
] as const;

export type PayrollAdjustmentField = typeof PAYROLL_ADJUSTMENT_FIELDS[number];

export interface AcceptedPayrollWorkbookAdjustment {
  employeeId: string;
  workDate?: string | null;
  field: PayrollAdjustmentField;
  value: string | number | boolean | null;
  sourceValueAtAcceptance: string | number | boolean | null;
  versionNumber: number;
  decidedAt: string;
}

export interface StoredPayrollWorkbookChange {
  stable_key: string | null;
  new_value: unknown;
  source_value_at_accept: unknown;
  decided_at: string;
  version_number: number;
}

const FIELD_SET = new Set<string>(PAYROLL_ADJUSTMENT_FIELDS);

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

export function parsePayrollAdjustmentStableKey(stableKey: string): {
  employeeId: string;
  workDate: string | null;
  field: PayrollAdjustmentField;
} | null {
  const parts = stableKey.split("|");
  if (parts.length < 2 || parts.length > 3) return null;
  const employeeId = parts[0];
  const workDate = parts.length === 3 ? parts[1] : null;
  const field = parts.at(-1) ?? "";
  if (!FIELD_SET.has(field)) return null;
  if ((field === "Código asistencia") !== (workDate !== null)) return null;
  if (workDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return null;
  return { employeeId, workDate, field: field as PayrollAdjustmentField };
}

/** Última decisión por trabajador/campo; una puesta en cero también se conserva. */
export function reduceAcceptedPayrollWorkbookChanges(
  rows: readonly StoredPayrollWorkbookChange[]
): AcceptedPayrollWorkbookAdjustment[] {
  const latest = new Map<string, AcceptedPayrollWorkbookAdjustment>();
  const ordered = [...rows].sort((left, right) =>
    left.version_number - right.version_number || left.decided_at.localeCompare(right.decided_at)
  );
  for (const row of ordered) {
    if (!row.stable_key) continue;
    const parsed = parsePayrollAdjustmentStableKey(row.stable_key);
    if (!parsed) continue;
    latest.set(row.stable_key, {
      ...parsed,
      value: scalar(row.new_value),
      sourceValueAtAcceptance: scalar(row.source_value_at_accept),
      versionNumber: row.version_number,
      decidedAt: row.decided_at,
    });
  }
  return [...latest.values()];
}

interface QueryResult {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
}
interface Query extends PromiseLike<QueryResult> {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  range(from: number, to: number): Query;
}

const QUERY_PAGE_SIZE = 1_000;
const VERSION_ID_BATCH_SIZE = 100;

async function allPages(build: (from: number, to: number) => Query): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += QUERY_PAGE_SIZE) {
    const page = await build(from, from + QUERY_PAGE_SIZE - 1);
    if (page.error) throw new Error(page.error.message);
    const data = page.data ?? [];
    rows.push(...data);
    if (data.length < QUERY_PAGE_SIZE) return rows;
  }
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function loadAcceptedPayrollWorkbookAdjustments(
  supabase: SupabaseClient<Database>,
  input: {
    companyId: string;
    windowType: "DIARIO" | "SEMANAL" | "QUINCENAL" | "MENSUAL";
    periodStart: string;
    periodEnd: string;
  }
): Promise<AcceptedPayrollWorkbookAdjustment[]> {
  const loose = supabase as unknown as { from(name: string): Query };
  const isMonthly = input.windowType === "MENSUAL";
  const versionTable = isMonthly ? "payroll_workbook_versions" : "payroll_working_versions";
  const changeTable = isMonthly ? "payroll_workbook_changes" : "payroll_working_changes";
  const changeVersionColumn = isMonthly ? "workbook_version_id" : "working_version_id";
  let versionRows: Record<string, unknown>[];
  try {
    versionRows = await allPages((from, to) => {
      let query = loose.from(versionTable)
        .select("id, version_number")
        .eq("company_id", input.companyId)
        .eq("period_start", input.periodStart)
        .eq("period_end", input.periodEnd);
      query = isMonthly
        ? query.eq("status", "ACCEPTED")
        : query.eq("window_type", input.windowType);
      return query.order("version_number", { ascending: true }).range(from, to);
    });
  } catch (error) {
    throw new Error(`loadAcceptedPayrollWorkbookAdjustments: ${error instanceof Error ? error.message : String(error)}`);
  }
  const versionNumbers = new Map<string, number>();
  for (const row of versionRows) {
    if (typeof row.id === "string" && typeof row.version_number === "number") versionNumbers.set(row.id, row.version_number);
  }
  if (versionNumbers.size === 0) return [];

  const changeRows: Record<string, unknown>[] = [];
  try {
    for (const ids of batches([...versionNumbers.keys()], VERSION_ID_BATCH_SIZE)) {
      changeRows.push(...await allPages((from, to) => loose.from(changeTable)
        .select(`id, ${changeVersionColumn}, stable_key, new_value, source_value_at_accept, decided_at`)
        .in(changeVersionColumn, ids)
        .eq("consequence", "AJUSTE_EMPRESARIAL")
        .order("decided_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)));
    }
  } catch (error) {
    throw new Error(`loadAcceptedPayrollWorkbookAdjustments: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reduceAcceptedPayrollWorkbookChanges(changeRows.map((row) => ({
    stable_key: typeof row.stable_key === "string" ? row.stable_key : null,
    new_value: row.new_value,
    source_value_at_accept: row.source_value_at_accept,
    decided_at: typeof row.decided_at === "string" ? row.decided_at : "",
    version_number: typeof row[changeVersionColumn] === "string"
      ? versionNumbers.get(String(row[changeVersionColumn])) ?? 0
      : 0,
  })));
}
