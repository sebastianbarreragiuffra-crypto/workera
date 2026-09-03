import "server-only";

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ExpenseEmailProviderConfig {
  enabled: boolean;
  apiKey: string;
  webhookSecret: string;
  receivingDomain: string;
}

export function getExpenseEmailDomain(): string | null {
  const domain = process.env.RESEND_RECEIVING_DOMAIN?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

export function getExpenseEmailProviderConfig(): ExpenseEmailProviderConfig | null {
  const receivingDomain = getExpenseEmailDomain();
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim() ?? "";
  if (!receivingDomain || !apiKey || !webhookSecret) return null;
  return {
    enabled: process.env.EXPENSE_EMAIL_CAPTURE_ENABLED === "true",
    apiKey,
    webhookSecret,
    receivingDomain,
  };
}

export function expenseEmailAddress(aliasToken: string, domain: string): string {
  return `comprobantes+${aliasToken.toLowerCase()}@${domain.toLowerCase()}`;
}
