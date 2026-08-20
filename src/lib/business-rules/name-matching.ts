/**
 * Normalización de nombre para matching EXACTO (nunca fuzzy) -- extraído
 * (Pre-Fase-8) para que `import-birthdays.ts`, `seed-known-schedules.ts` y
 * `employee-roster-reconciliation.ts` compartan el mismo criterio en vez de
 * triplicarlo.
 *
 * Diferencias superficiales tratadas como iguales (explícitamente
 * autorizado por el encargo): mayúsculas/minúsculas, espacios al
 * borde/repetidos, y normalización Unicode/acentos (NFD + remoción de
 * marcas diacríticas -- ej. "Núñez" y "Nunez" se consideran el mismo
 * nombre, dato real de que fuentes distintas -- Excel de RRHH vs Workera --
 * tipean acentos de forma inconsistente).
 *
 * NUNCA hace comparación parcial/por similitud -- dos nombres normalizados
 * deben ser EXACTAMENTE iguales para considerarse un match; eso es lo que
 * distingue esta normalización de fuzzy matching (explícitamente prohibido
 * para vincular personas).
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas diacríticas combinantes (acentos, tilde, diéresis)
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/**
 * Normalización de RUT para identidad canónica de proveedores (Nómina de
 * Pago -- reemplazo del maestro). Quita puntos/guion/espacios, mayúsculas.
 * A diferencia de `normalizeName`, este SÍ es un identificador estable
 * confiable (el nombre puede escribirse de formas distintas para el mismo
 * proveedor; el RUT no).
 */
export function normalizeRut(value: string): string {
  return value.toUpperCase().replace(/[^0-9K]/g, "");
}
