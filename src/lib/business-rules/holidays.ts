import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { HolidaySet } from "./business-days";

/**
 * Carga los feriados legales VIGENTES (`active`) de un rango, como un
 * `Set<string>` de fechas `yyyy-MM-dd` -- el formato que consumen
 * `isBusinessDay` / `addBusinessDays`.
 *
 * Fuente única: la tabla `holidays` (poblada en
 * `20260901180000_chilean_legal_holidays.sql`, editable por RRHH vía la
 * policy `holidays_write_admin`). El lado SQL del motor de horas extra ya
 * consulta esa misma tabla en `classify_overtime_type_id` -- este helper es su
 * equivalente para el código TypeScript, no una segunda fuente de verdad.
 */
export async function loadHolidaySet(
  supabase: SupabaseClient<Database>,
  fromDate: string,
  toDate: string
): Promise<HolidaySet> {
  const { data, error } = await supabase
    .from("holidays")
    .select("holiday_date")
    .eq("active", true)
    .gte("holiday_date", fromDate)
    .lte("holiday_date", toDate);

  if (error) {
    throw new Error(`loadHolidaySet: fallo leyendo holidays: ${error.message}`);
  }

  return new Set((data ?? []).map((r) => r.holiday_date));
}

/**
 * Ventana de fechas con holgura suficiente para cualquier plazo corto de "N
 * días hábiles". Un plazo de 3 días hábiles nunca se estira más allá de ~2
 * semanas calendario, aunque caigan feriados y fin de semana en medio.
 */
export function holidayWindow(date: string, daysBefore = 3, daysAfter = 21): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(base - daysBefore * 86_400_000), to: iso(base + daysAfter * 86_400_000) };
}
