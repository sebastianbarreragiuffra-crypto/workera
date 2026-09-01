/**
 * Conversión de un instante real (Date/timestamptz) a minutos-desde-medianoche
 * en la hora de PARED de America/Santiago -- vía `Intl.DateTimeFormat`
 * (respeta DST automáticamente por el tzdata del runtime, mismo criterio que
 * src/lib/sync/target-date.ts). Nunca lee `.getUTCHours()`/`.getHours()`
 * directamente sobre el instante: eso da la hora UTC o la hora local del
 * SERVIDOR, no la hora de pared de Santiago -- error real encontrado y
 * corregido durante el desarrollo de Fase 7 (los primeros motores de
 * atraso/salida anticipada comparaban minutos en dominios de tiempo
 * distintos, dando resultados desfasados exactamente por el offset UTC-4).
 */
export function santiagoWallClockMinutesSinceMidnight(instant: Date, timeZone: string = "America/Santiago"): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const minute = Number(parts.find((p) => p.type === "minute")!.value);
  return hour * 60 + minute;
}

export function scheduledTimeToMinutes(scheduledTime: string): number {
  const [h, m] = scheduledTime.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Operación INVERSA de `santiagoWallClockMinutesSinceMidnight`: toma una fecha
 * calendario + una hora de pared que escribió una persona ("2026-09-01",
 * "17:30") y devuelve el instante ISO correspondiente en Santiago.
 *
 * Necesaria desde MB-3: cuando un jefe corrige una marcación olvidada, escribe
 * la hora que el trabajador realmente salió -- hora de pared, no UTC. Dejar
 * que el servidor la interprete en SU zona local daría un instante corrido por
 * el offset (el servidor de producción corre en UTC), que es exactamente el
 * bug que Fase 7 ya encontró en la dirección contraria.
 *
 * El offset sale de `Intl` (tzdata real, DST incluido), nunca de un -03:00/
 * -04:00 hardcodeado.
 */
export function santiagoWallClockToInstant(
  calendarDate: string,
  wallClock: string,
  timeZone: string = "America/Santiago"
): Date {
  const [year, month, day] = calendarDate.split("-").map(Number);
  const [hour, minute] = wallClock.split(":").map(Number);

  // Instante tentativo interpretando la hora de pared como si fuera UTC; luego
  // se mide cuánto se desvía la pared de Santiago respecto de él y se corrige.
  const tentative = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(tentative));

  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const santiagoAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));

  return new Date(tentative - (santiagoAsUtc - tentative));
}
