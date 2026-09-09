import { z } from "zod";

/**
 * Identificador UUID tal como lo acepta PostgreSQL.
 *
 * `z.string().uuid()` valida además los bits de versión/variante de RFC 9562.
 * La base histórica usa algunos UUID deterministas (por ejemplo ARCOTEX) que
 * PostgreSQL acepta pero que no declaran una versión RFC. `z.guid()` conserva
 * el formato canónico con guiones sin imponer esos bits.
 */
export const postgresUuid = z.guid();

/**
 * Valida y devuelve la representación única que se usa en comparaciones y
 * consultas. PostgreSQL acepta dígitos hexadecimales en mayúscula, pero los
 * guardrails de aplicación no deben depender de esa diferencia textual.
 */
export function requireCanonicalPostgresUuid(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("El identificador UUID no es válido.");
  }

  const result = postgresUuid.safeParse(value.trim().toLowerCase());
  if (!result.success) {
    throw new Error("El identificador UUID no es válido.");
  }
  return result.data;
}
