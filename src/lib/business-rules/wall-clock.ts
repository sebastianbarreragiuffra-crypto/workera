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
