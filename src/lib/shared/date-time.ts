/**
 * Utilidades de fecha calendario e instantes compartidas por todos los dominios.
 *
 * Este módulo no conoce asistencia, rendiciones ni plataforma. Mantenerlo en el
 * kernel compartido evita que un dominio importe los view-models de otro solo
 * para reutilizar la zona horaria operacional.
 */
export const SANTIAGO_TIME_ZONE = "America/Santiago";

type Instant = Date | number | string;
type SantiagoFormatOptions = Omit<Intl.DateTimeFormatOptions, "timeZone">;

function instantDate(value: Instant): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Instante inválido: ${String(value)}`);
  return date;
}

export function formatInstantInSantiago(value: Instant, options: SantiagoFormatOptions): string {
  return new Intl.DateTimeFormat("es-CL", { ...options, timeZone: SANTIAGO_TIME_ZONE }).format(instantDate(value));
}

export function formatTimeInSantiago(value: Instant): string {
  return formatInstantInSantiago(value, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function formatDateTimeInSantiago(value: Instant): string {
  return formatInstantInSantiago(value, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
}

export function isCalendarDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
}

export function formatCalendarDate(
  date: string,
  options: SantiagoFormatOptions = { dateStyle: "short" }
): string {
  if (!isCalendarDate(date)) throw new RangeError(`Fecha calendario inválida: ${date}`);

  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("es-CL", { ...options, timeZone: "UTC" }).format(instant);
}

export function todayInSantiago(now: Date = new Date(), timeZone = SANTIAGO_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  const day = parts.find((part) => part.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

function shiftDate(date: string, deltaDays: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + deltaDays * 86_400_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function santiagoDayStartIso(date: string): string {
  formatCalendarDate(date);
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: SANTIAGO_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")!.value;
  return `${date}T00:00:00${offset.replace("GMT", "") || "+00:00"}`;
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
