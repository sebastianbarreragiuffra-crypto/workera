/** RFC 6266/RFC 5987, sin permitir controles, CRLF ni comillas en metadata. */
export function attachmentContentDisposition(originalFilename: string): string {
  const cleanUnicode = originalFilename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(-180) || "archivo";
  const ascii = cleanUnicode
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(cleanUnicode).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Cabeceras comunes para bytes privados. Fuerza descarga y evita cache/render
 * activo aunque el archivo declare un MIME interpretable por el navegador.
 */
export function privateAttachmentHeaders(
  originalFilename: string,
  byteLength: number,
  rateLimit?: { limit: number; remaining: number },
): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "application/octet-stream",
    "Content-Disposition": attachmentContentDisposition(originalFilename),
    "Content-Length": String(byteLength),
    "Content-Security-Policy": "sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Download-Options": "noopen",
    ...(rateLimit ? {
      "RateLimit-Limit": String(rateLimit.limit),
      "RateLimit-Remaining": String(rateLimit.remaining),
    } : {}),
  };
}
