/**
 * Los resolvers hacen aritmética con `Number(...)` sobre las dos mitades de
 * `mes` y no validan nada: `2026-00` producía `startDate = "2026-00-01"`, que
 * Postgres rechaza recién dentro de la consulta, y `2026-13` devolvía enero del
 * año siguiente en silencio. Se exige el mes real antes de llegar ahí.
 */
export function requireYearMonth(value: string | null): string {
  if (!value) throw new Error("Falta el parámetro 'mes' (formato YYYY-MM).");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("El parámetro 'mes' debe tener el formato YYYY-MM, con un mes entre 01 y 12.");
  }
  return value;
}
