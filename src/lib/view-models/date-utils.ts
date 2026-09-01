/**
 * Utilidad de fecha para la UI (Fase 8) -- "hoy" en America/Santiago, no
 * "hoy en el servidor" (que puede correr en UTC). Deliberadamente separado
 * de `sync/target-date.ts` (que resuelve D-1 para el pipeline de
 * sincronización, un concepto distinto) para no acoplar la UI a semántica
 * de sync.
 */
export const SANTIAGO_TIME_ZONE = "America/Santiago";

type Instant = Date | number | string;
type SantiagoFormatOptions = Omit<Intl.DateTimeFormatOptions, "timeZone">;

function instantDate(value: Instant): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Instante inválido: ${String(value)}`);
  return date;
}

/**
 * Formatea un instante real (timestamptz/ISO) en la zona operacional de la
 * aplicación. `timeZone` se fija al final para que ningún caller pueda volver
 * accidentalmente a la zona local del navegador o del servidor.
 */
export function formatInstantInSantiago(value: Instant, options: SantiagoFormatOptions): string {
  return new Intl.DateTimeFormat("es-CL", { ...options, timeZone: SANTIAGO_TIME_ZONE }).format(instantDate(value));
}

export function formatTimeInSantiago(value: Instant): string {
  return formatInstantInSantiago(value, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function formatDateTimeInSantiago(value: Instant): string {
  return formatInstantInSantiago(value, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
}

/** Formatea YYYY-MM-DD como fecha calendario, sin convertirla entre zonas. */
export function formatCalendarDate(date: string, options: SantiagoFormatOptions = { dateStyle: "short" }): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Fecha calendario inválida: ${date}`);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    throw new RangeError(`Fecha calendario inválida: ${date}`);
  }

  return new Intl.DateTimeFormat("es-CL", { ...options, timeZone: "UTC" }).format(instant);
}

export function todayInSantiago(now: Date = new Date(), timeZone = SANTIAGO_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

function shiftDate(date: string, deltaDays: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + deltaDays * 86_400_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function previousDate(date: string): string {
  return shiftDate(date, -1);
}

export function nextDate(date: string): string {
  return shiftDate(date, 1);
}

export function formatDateLong(date: string): string {
  return formatCalendarDate(date, { day: "numeric", month: "long", year: "numeric" });
}
