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
