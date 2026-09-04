import "server-only";

const GRAPH_VERSION = /^v\d{1,2}\.\d{1,2}$/;
const PHONE_ID = /^\d{5,32}$/;
const PHONE_DISPLAY = /^\+?\d{8,16}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ExpenseWhatsappProviderConfig {
  enabled: boolean;
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  businessNumber: string;
  graphVersion: string;
  linkSecret: string;
  mediaHosts: ReadonlySet<string>;
}

export function getExpenseWhatsappProviderConfig(): ExpenseWhatsappProviderConfig | null {
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const businessNumber = process.env.WHATSAPP_BUSINESS_NUMBER?.trim() ?? "";
  const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION?.trim() ?? "";
  const linkSecret = process.env.WHATSAPP_LINK_SECRET?.trim() ?? "";
  const rawMediaHosts = (process.env.WHATSAPP_MEDIA_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  const mediaHosts = new Set(rawMediaHosts);

  if (appSecret.length < 16 || verifyToken.length < 16 || accessToken.length < 20 || linkSecret.length < 32
    || !PHONE_ID.test(phoneNumberId) || !PHONE_DISPLAY.test(businessNumber)
    || !GRAPH_VERSION.test(graphVersion) || mediaHosts.size === 0
    || rawMediaHosts.some((host) => !HOSTNAME.test(host))) return null;

  return {
    enabled: process.env.EXPENSE_WHATSAPP_CAPTURE_ENABLED === "true",
    appSecret,
    verifyToken,
    accessToken,
    phoneNumberId,
    businessNumber,
    graphVersion,
    linkSecret,
    mediaHosts,
  };
}

export function whatsappLink(number: string, pairingCode: string): string {
  const digits = number.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(`VINCULAR ${pairingCode}`)}`;
}
