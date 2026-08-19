/**
 * Regla de cumpleaños (Fase 7, PASO 29-32). Pura: recibe la fecha calendario
 * y la hora de salida, nunca llama a `new Date()` internamente más allá de
 * derivar el día de la semana de la fecha recibida (mismo patrón que
 * business-days.ts).
 *
 * Regla confirmada: si el cumpleaños cae lunes-viernes, el trabajador está
 * autorizado a retirarse desde las 12:00 sin descuento por salida
 * anticipada. Si cae sábado/domingo, la regla simplemente NO aplica ese
 * año -- sin traslado automático a viernes/lunes (PASO 30, decisión
 * explícita de negocio: no inventar una regla de traslado).
 */

const BIRTHDAY_AUTHORIZED_FROM = "12:00:00";

export interface BirthdayContext {
  birthMonth: number;
  birthDay: number;
}

function dayOfWeekUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=domingo..6=sábado
}

/** true solo si `date` es exactamente el cumpleaños Y cae lunes-viernes -- nunca el fin de semana, nunca un día adyacente. */
export function isBirthdayWeekdayAuthorizationApplicable(birthday: BirthdayContext, date: string): boolean {
  const [, month, day] = date.split("-").map(Number);
  if (month !== birthday.birthMonth || day !== birthday.birthDay) return false;
  const dow = dayOfWeekUtc(date);
  return dow >= 1 && dow <= 5;
}

/**
 * Compara una hora "HH:MM:SS" contra el umbral de autorización (12:00:00).
 * Solo tiene sentido llamarla cuando `isBirthdayWeekdayAuthorizationApplicable`
 * ya es true -- antes de las 12:00 en el propio cumpleaños sigue siendo
 * candidata a salida anticipada normal (PASO 32), no autorizada.
 */
export function isAfterBirthdayAuthorizationThreshold(actualEndTime: string): boolean {
  return actualEndTime >= BIRTHDAY_AUTHORIZED_FROM;
}

export { BIRTHDAY_AUTHORIZED_FROM };
