import "server-only";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mailbox(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const bracketed = trimmed.match(/<([^<>]+)>$/)?.[1];
  return (bracketed ?? trimmed).trim();
}

export function resolveSingleExpenseAliasToken(recipients: string[], domain: string): string | null {
  const normalizedDomain = domain.trim().toLowerCase();
  const tokens = new Set<string>();
  for (const recipient of recipients) {
    const email = mailbox(recipient);
    const separator = email.lastIndexOf("@");
    if (separator <= 0 || email.slice(separator + 1) !== normalizedDomain) continue;
    const local = email.slice(0, separator);
    if (!local.startsWith("comprobantes+")) continue;
    const token = local.slice("comprobantes+".length);
    if (UUID_PATTERN.test(token)) tokens.add(token);
  }
  return tokens.size === 1 ? [...tokens][0] : null;
}

export function isTrustedResendAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "inbound-cdn.resend.com"
      && url.username === ""
      && url.password === ""
      && url.port === "";
  } catch {
    return false;
  }
}

export function safeAttachmentFilename(value: string | undefined, fallbackExtension: string): string {
  const basename = (value ?? "").split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  return (basename || `comprobante.${fallbackExtension}`).slice(0, 240);
}
