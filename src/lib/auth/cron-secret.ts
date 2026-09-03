import { timingSafeEqual } from "node:crypto";

/**
 * Comparación del secreto de cron, en UN solo lugar.
 *
 * Vercel Cron agrega `Authorization: Bearer $CRON_SECRET` y llega ANTES de que
 * exista sesión de usuario, así que dos capas necesitan la misma decisión: el
 * middleware (para no redirigir el request al login) y el route handler (que la
 * revalida por su cuenta y es la autoridad real). Tenerla duplicada significaba
 * que endurecer una copia dejaba la otra atrás sin que nada lo delatara.
 *
 * `CRON_SECRET` es un secreto INDEPENDIENTE de `WORKERA_API_KEY` y de
 * `SUPABASE_SERVICE_ROLE_KEY`; ninguno de esos se reutiliza aquí. Fail-closed:
 * sin secreto configurado en el servidor, ningún request pasa.
 *
 * Recibe el header ya extraído en vez de un `NextRequest` para no arrastrar
 * dependencias de Next a quien solo necesita comparar el secreto.
 */
export function isValidCronSecretHeader(header: string | null | undefined): boolean {
  const configured = process.env.CRON_SECRET;
  if (!configured) return false;
  if (!header?.startsWith("Bearer ")) return false;

  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(configured);
  // `timingSafeEqual` exige igual longitud: comparar antes evita que lance.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
