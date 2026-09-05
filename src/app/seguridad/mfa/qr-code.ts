const SVG_DATA_URI_PREFIX = "data:image/svg+xml;utf-8,";

/**
 * Supabase Auth ya entrega el SVG del TOTP como un data URI completo.
 * Mantenerlo intacto evita codificar por segunda vez el prefijo y romper la
 * imagen. La lista permitida también impide aceptar esquemas inesperados.
 */
export function normalizeMfaQrCodeDataUri(value: string): string {
  const qrCodeDataUri = value.trim();

  if (!qrCodeDataUri.startsWith(SVG_DATA_URI_PREFIX)) {
    throw new Error("Supabase devolvió un formato de QR no permitido.");
  }

  const payload = qrCodeDataUri.slice(SVG_DATA_URI_PREFIX.length);
  if (payload.startsWith("data%3A") || payload.startsWith("data:")) {
    throw new Error("Supabase devolvió un QR codificado más de una vez.");
  }

  return qrCodeDataUri;
}
