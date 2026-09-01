/**
 * Días hábiles: lunes-viernes, descontando además los feriados legales que se
 * le pasen explícitamente (MB-6).
 *
 * El calendario de feriados NO se lee acá -- estas funciones siguen siendo
 * puras y sin I/O (mismo patrón "dominio UTC sintético" que
 * src/lib/sync/target-date.ts). El llamador carga los feriados del rango que
 * necesita (ver `src/lib/business-rules/holidays.ts`) y los inyecta como un
 * `Set<string>` de fechas `yyyy-MM-dd`. Sin ese set, el comportamiento es el
 * histórico: solo se descuentan sábados y domingos.
 */

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function formatDate({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayOfWeekUtc(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=domingo .. 6=sábado
}

export type HolidaySet = ReadonlySet<string>;

const EMPTY_HOLIDAYS: HolidaySet = new Set<string>();

export function isBusinessDay(date: string, holidays: HolidaySet = EMPTY_HOLIDAYS): boolean {
  const { year, month, day } = parseDate(date);
  const dow = dayOfWeekUtc(year, month, day);
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(date);
}

/**
 * Suma `days` días HÁBILES a `date` (yyyy-MM-dd). El día de inicio nunca cuenta
 * como uno de los días sumados, aunque sea hábil -- ejemplo confirmado por el
 * encargo: viernes + 3 días hábiles = miércoles (lunes, martes, miércoles).
 *
 * Un feriado en `holidays` que cae entre medio también se salta: viernes + 3
 * días hábiles, con el lunes feriado, cae el jueves.
 */
export function addBusinessDays(date: string, days: number, holidays: HolidaySet = EMPTY_HOLIDAYS): string {
  if (days < 0) {
    throw new Error(`addBusinessDays: days debe ser >= 0, recibido: ${days}`);
  }
  const { year, month, day } = parseDate(date);
  let current = Date.UTC(year, month - 1, day);
  let remaining = days;

  while (remaining > 0) {
    current += 86_400_000;
    const d = new Date(current);
    const iso = formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(iso)) remaining -= 1;
  }

  const result = new Date(current);
  return formatDate({ year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() });
}
