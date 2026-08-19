/**
 * Utilidad de fecha para la UI (Fase 8) -- "hoy" en America/Santiago, no
 * "hoy en el servidor" (que puede correr en UTC). Deliberadamente separado
 * de `sync/target-date.ts` (que resuelve D-1 para el pipeline de
 * sincronización, un concepto distinto) para no acoplar la UI a semántica
 * de sync.
 */
export function todayInSantiago(now: Date = new Date(), timeZone = "America/Santiago"): string {
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
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("es-CL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}
