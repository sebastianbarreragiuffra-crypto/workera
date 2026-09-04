/**
 * `batchId` llega desde la URL y termina interpolado en el header
 * `Content-Disposition`. Sin validarlo, unas comillas permiten inventar un
 * segundo `filename=` y un CRLF hace que Node rechace el header y la descarga
 * muera con un 500. Exigir un UUID -- que es lo único que la columna acepta --
 * cierra las dos puertas y de paso evita mandar basura a Postgres.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
