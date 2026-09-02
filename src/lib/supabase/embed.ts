/**
 * PostgREST devuelve un embed `to-one` como objeto cuando la FK es directa,
 * pero como array de un elemento cuando el embed pasa por una relación que
 * el cliente no puede probar unívocamente `to-one` (p. ej. sin el nombre
 * explícito del constraint). Este helper normaliza ambos casos -- reutilizado
 * en vez de repetir el mismo `Array.isArray(x) ? x[0] : x` en cada archivo
 * que hace un embed de este tipo.
 */
export function unwrapEmbed<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
