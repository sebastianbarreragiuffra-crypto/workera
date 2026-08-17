import type { NormalizedInstant } from "../types/normalized";

/**
 * Normaliza un timestamp crudo de Workera a un instante UTC, conservando el
 * valor original para auditoría/depuración. El schema (schemas/attendance.ts)
 * ya garantizó que `raw` es parseable antes de que este mapper se ejecute.
 *
 * Timezone (sección 18 del encargo): NO se asume que el timestamp crudo ya
 * viene en America/Santiago ni en UTC — `Date.parse` respeta el offset
 * incluido en el propio string cuando existe. Si Workera entrega timestamps
 * sin offset (hora local implícita), este comportamiento deberá revisarse
 * explícitamente cuando se confirme el formato real (Fase 5) —
 * documentado, no resuelto silenciosamente aquí.
 */
export function toNormalizedInstant(raw: string): NormalizedInstant {
  return { utc: new Date(raw).toISOString(), raw };
}

export function toNormalizedInstantOrNull(raw: string | null | undefined): NormalizedInstant | null {
  if (raw === null || raw === undefined) return null;
  return toNormalizedInstant(raw);
}
