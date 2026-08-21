/**
 * Límites de período para el exportador de asistencia (Fase 9). Exactamente
 * tres modos, sin rango arbitrario -- ver DescargarAsistenciaCard.tsx.
 *
 * SEMANAL reutiliza `currentWeekRange` (dashboard-view.ts), el mismo cálculo
 * lunes-domingo ya usado en el resto de la app -- ninguna aritmética de
 * fecha nueva. QUINCENAL es un rango de CALENDARIO fijo (1-15 / 16-fin de
 * mes), deliberadamente DISTINTO del ciclo 15-15 que ya usa Colaciones para
 * sus propios descuentos (ese ciclo es de facturación, no de asistencia --
 * no se reutiliza acá). MENSUAL es 1º al último día calendario del mes.
 */
import { currentWeekRange } from "../view-models/dashboard-view";

export type AttendanceExportType = "SEMANAL" | "QUINCENAL" | "MENSUAL";

export interface AttendanceExportPeriod {
  type: AttendanceExportType;
  startDate: string;
  endDate: string;
  label: string;
}

const MONTH_LABEL = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric", timeZone: "UTC" });

function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function fmt(year: number, month1to12: number, day: number): string {
  return `${year}-${String(month1to12).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthLabel(year: number, month1to12: number): string {
  const label = MONTH_LABEL.format(new Date(Date.UTC(year, month1to12 - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** SEMANAL: cualquier fecha dentro de la semana deseada -- se resuelve a lunes-domingo. */
export function resolveWeeklyPeriod(anyDateInWeek: string): AttendanceExportPeriod {
  const { start, end } = currentWeekRange(anyDateInWeek);
  return { type: "SEMANAL", startDate: start, endDate: end, label: `Semana ${start} al ${end}` };
}

/** QUINCENAL: mes (YYYY-MM) + quincena 1 (1-15) o 2 (16-fin de mes). Nunca una ventana móvil de 14/15 días. */
export function resolveFortnightPeriod(yearMonth: string, half: 1 | 2): AttendanceExportPeriod {
  const [yearStr, monthStr] = yearMonth.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (half === 1) {
    return { type: "QUINCENAL", startDate: fmt(year, month, 1), endDate: fmt(year, month, 15), label: `1ª quincena de ${monthLabel(year, month)} (1 al 15)` };
  }
  const lastDay = lastDayOfMonth(year, month);
  return { type: "QUINCENAL", startDate: fmt(year, month, 16), endDate: fmt(year, month, lastDay), label: `2ª quincena de ${monthLabel(year, month)} (16 al ${lastDay})` };
}

/** MENSUAL: mes (YYYY-MM) completo, 1º al último día calendario. */
export function resolveMonthlyPeriod(yearMonth: string): AttendanceExportPeriod {
  const [yearStr, monthStr] = yearMonth.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const lastDay = lastDayOfMonth(year, month);
  return { type: "MENSUAL", startDate: fmt(year, month, 1), endDate: fmt(year, month, lastDay), label: monthLabel(year, month) };
}
