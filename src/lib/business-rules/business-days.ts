/**
 * Días hábiles (Fase 7, PASO 18): lunes-viernes. SIN calendario de feriados
 * legales chilenos todavía -- limitación documentada explícitamente (PASO
 * 18/74 del encargo: "no inventar feriados legales si no tenemos calendario
 * de feriados implementado"). El esquema ya tiene una tabla `holidays`
 * (Gate D, motor de horas extra) -- conectar `addBusinessDays` a ella queda
 * para una fase futura sin necesitar cambiar esta firma.
 *
 * Pura, sin `new Date()` interno más allá de aritmética de calendario sobre
 * el parámetro recibido -- mismo patrón "dominio UTC sintético" que
 * src/lib/sync/target-date.ts, para que sumar días calendario nunca dependa
 * de la hora de pared real ni de DST.
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

export function isBusinessDay(date: string): boolean {
  const { year, month, day } = parseDate(date);
  const dow = dayOfWeekUtc(year, month, day);
  return dow !== 0 && dow !== 6;
}

/**
 * Suma `days` días HÁBILES (lunes-viernes) a `date` (yyyy-MM-dd). El día de
 * inicio nunca cuenta como uno de los días sumados, aunque sea hábil --
 * ejemplo confirmado por el encargo: viernes + 3 días hábiles = miércoles
 * (lunes, martes, miércoles).
 */
export function addBusinessDays(date: string, days: number): string {
  if (days < 0) {
    throw new Error(`addBusinessDays: days debe ser >= 0, recibido: ${days}`);
  }
  const { year, month, day } = parseDate(date);
  let current = Date.UTC(year, month - 1, day);
  let remaining = days;

  while (remaining > 0) {
    current += 86_400_000;
    const dow = new Date(current).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }

  const result = new Date(current);
  return formatDate({ year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() });
}
