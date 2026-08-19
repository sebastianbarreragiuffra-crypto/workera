/**
 * Resolución de fechas objetivo para la automatización (Fase 6B). Funciones
 * PURAS -- reciben el reloj como parámetro (nunca `new Date()` interno,
 * PASO 39 del encargo) para ser deterministas en tests sin esperar hasta una
 * hora real.
 *
 * Regla central (PASO 2/38): "día calendario anterior", no "menos 24
 * horas". La diferencia importa en los días de cambio de horario de verano
 * en Chile, que tienen 23 o 25 horas reales -- restar 24h de una hora de
 * pared real puede aterrizar en el día equivocado. Esta implementación
 * nunca resta milisegundos de una hora de pared: primero resuelve el
 * año/mes/día calendario EN LA ZONA HORARIA vía `Intl.DateTimeFormat`
 * (que ya conoce las reglas de DST reales de esa zona), y luego hace
 * aritmética de ENTEROS de calendario sobre esos tres números -- un dominio
 * sin DST, donde "un día calendario antes" siempre es exacto.
 */

const DEFAULT_TIME_ZONE = "America/Santiago";

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function calendarDateInTimeZone(instant: Date, timeZone: string): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(instant);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  const day = Number(parts.find((p) => p.type === "day")!.value);
  return { year, month, day };
}

function formatCalendarDate({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Resta `days` días CALENDARIO (no horas) de una fecha calendario. Opera
 * sobre una representación UTC sintética de la fecha (medianoche UTC de ese
 * año/mes/día) -- un dominio sin DST propio, así que sumar/restar N*86400000
 * ms siempre mueve exactamente N días calendario, sin importar qué zona
 * horaria real se usó para obtener year/month/day originalmente.
 */
function subtractCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const asUtcMidnight = Date.UTC(date.year, date.month - 1, date.day);
  const shifted = new Date(asUtcMidnight - days * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * Día calendario anterior (D-1) en la zona horaria dada, a partir de un
 * instante `now` inyectado. Ejemplo: ejecución 2026-08-20 07:00
 * America/Santiago -> "2026-08-19".
 */
export function resolveTargetDate(now: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const today = calendarDateInTimeZone(now, timeZone);
  const yesterday = subtractCalendarDays(today, 1);
  return formatCalendarDate(yesterday);
}

/**
 * Ventana de reconciliación (Fase 6B, PASO 18/19): además del día objetivo
 * (D-1), una pequeña cantidad configurable de días ANTERIORES a él, para
 * volver a consultar Workera y capturar MODIFICADO/INACTIVO/correcciones
 * reportadas después del sync original de esos días. Nunca un backfill
 * histórico -- `reconciliationDays` debe mantenerse pequeño (default
 * documentado en config.ts).
 *
 * Devuelve las fechas ordenadas de más antigua a más reciente, terminando
 * siempre en `targetDate` (la fecha "principal" de esta corrida).
 */
export function resolveReconciliationWindow(targetDate: string, reconciliationDays: number): string[] {
  if (reconciliationDays < 0) {
    throw new Error(`reconciliationDays debe ser >= 0, recibido: ${reconciliationDays}`);
  }
  const [year, month, day] = targetDate.split("-").map(Number);
  const dates: string[] = [];
  for (let offset = reconciliationDays; offset >= 0; offset -= 1) {
    const shifted = subtractCalendarDays({ year, month, day }, offset);
    dates.push(formatCalendarDate(shifted));
  }
  return dates;
}
