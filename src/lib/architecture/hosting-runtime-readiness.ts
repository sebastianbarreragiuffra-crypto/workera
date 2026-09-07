export type HostingCheckStatus = "PASS" | "FAIL" | "SAFE_DISABLED";

export interface HostingCheck {
  readonly id: string;
  readonly status: HostingCheckStatus;
  readonly detail: string;
}

export interface HostingRuntimeReport {
  readonly decision: "READY" | "NOT_READY";
  readonly checks: readonly HostingCheck[];
}

type Environment = Readonly<Record<string, string | undefined>>;

export const EXPECTED_CRON_PATHS = [
  "/api/sync/workera",
  "/api/jobs/expense-ocr",
  "/api/jobs/expense-file-scan",
  "/api/jobs/expense-assistant-retention",
  "/api/jobs/supporting-document-cleanup",
  "/api/jobs/expense-accounting",
  "/api/jobs/expense-accounting-watchdog",
] as const;

function isConfigured(value: string | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(normalized && normalized !== "[SENSITIVE]");
}

function hasStrongCronSecret(value: string | undefined): boolean {
  if (!isConfigured(value) || !value || value.trim() !== value) return false;
  return Buffer.byteLength(value, "utf8") >= 32;
}

function isHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function check(
  id: string,
  condition: boolean,
  success: string,
  failure: string,
): HostingCheck {
  return { id, status: condition ? "PASS" : "FAIL", detail: condition ? success : failure };
}

function integrationCheck(
  id: string,
  enabled: boolean,
  validWhenEnabled: boolean,
  success: string,
  failure: string,
): HostingCheck {
  if (!enabled) {
    return { id, status: "SAFE_DISABLED", detail: "Deshabilitada de forma segura por feature flag." };
  }
  return check(id, validWhenEnabled, success, failure);
}

export function evaluateHostingRuntime(
  env: Environment,
  configuredCronPaths: readonly string[],
): HostingRuntimeReport {
  const uniqueCronPaths = [...new Set(configuredCronPaths)].sort();
  const expectedCronPaths = [...EXPECTED_CRON_PATHS].sort();
  const workeraEnabled = env.WORKERA_SYNC_ENABLED === "true";
  const ocrEnabled = env.EXPENSE_OCR_ENABLED === "true";
  const fileScanEnabled = env.EXPENSE_FILE_SCAN_ENABLED === "true";
  const accountingEnabled = env.EXPENSE_ACCOUNTING_EXPORT_ENABLED === "true";
  const cleanupEnabled = env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED === "true";

  const checks: HostingCheck[] = [
    check(
      "public_origin",
      isHttpsOrigin(env.APP_PUBLIC_ORIGIN),
      "El origen público es HTTPS y no contiene ruta ni credenciales.",
      "APP_PUBLIC_ORIGIN debe ser el origen HTTPS canónico del ambiente.",
    ),
    check(
      "supabase_public_client",
      isHttpsOrigin(env.NEXT_PUBLIC_SUPABASE_URL) && isConfigured(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      "El cliente público de Supabase está configurado.",
      "Falta NEXT_PUBLIC_SUPABASE_URL HTTPS o NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    ),
    check(
      "supabase_server_client",
      isConfigured(env.SUPABASE_SERVICE_ROLE_KEY),
      "La credencial server-only de Supabase está configurada.",
      "Falta SUPABASE_SERVICE_ROLE_KEY.",
    ),
    check(
      "mfa_enforcement",
      env.MFA_ENFORCEMENT_ENABLED === "true",
      "MFA está exigido para las identidades privilegiadas.",
      "MFA_ENFORCEMENT_ENABLED debe ser true antes de operar con datos reales.",
    ),
    check(
      "cron_manifest",
      configuredCronPaths.length === uniqueCronPaths.length
        && JSON.stringify(uniqueCronPaths) === JSON.stringify(expectedCronPaths),
      "El manifiesto contiene exactamente los siete procesos programados aprobados.",
      "vercel.json no coincide con el inventario aprobado de procesos programados.",
    ),
    check(
      "cron_secret",
      hasStrongCronSecret(env.CRON_SECRET),
      "El canal de invocación de cron tiene un secreto independiente fuerte.",
      "CRON_SECRET debe existir y tener al menos 32 caracteres.",
    ),
    integrationCheck(
      "workera_sync",
      workeraEnabled,
      env.WORKERA_PROVIDER === "http"
        && isHttpsUrl(env.WORKERA_BASE_URL)
        && isConfigured(env.WORKERA_API_USER)
        && isConfigured(env.WORKERA_API_KEY),
      "Workera está habilitado con proveedor HTTP y credenciales completas.",
      "Workera está habilitado pero su proveedor, URL o credenciales están incompletos.",
    ),
    integrationCheck(
      "expense_ocr",
      ocrEnabled,
      env.EXPENSE_OCR_PROVIDER === "azure-document-intelligence"
        && isHttpsUrl(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT)
        && isConfigured(env.AZURE_DOCUMENT_INTELLIGENCE_KEY),
      "OCR está habilitado con Azure configurado.",
      "OCR está habilitado pero Azure no está configurado completamente.",
    ),
    integrationCheck(
      "expense_file_scan",
      fileScanEnabled,
      false,
      "El escáner antimalware real está configurado.",
      "No existe todavía un proveedor antimalware habilitable en producción.",
    ),
    integrationCheck(
      "expense_accounting",
      accountingEnabled,
      env.EXPENSE_ACCOUNTING_PROVIDER === "dry-run",
      "La salida contable está habilitada únicamente en modo dry-run.",
      "La salida contable habilitada debe permanecer en dry-run hasta aprobar un ERP real.",
    ),
    integrationCheck(
      "supporting_document_cleanup",
      cleanupEnabled,
      env.SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED === "true",
      "La limpieza documental está activa y su monitor espera actividad.",
      "La limpieza está activa pero el monitor no detectaría una desactivación accidental.",
    ),
  ];

  return {
    decision: checks.some((item) => item.status === "FAIL") ? "NOT_READY" : "READY",
    checks,
  };
}

export function renderHostingRuntimeReport(report: HostingRuntimeReport): string {
  const lines = [`HOSTING_RUNTIME ${report.decision}`];
  for (const item of report.checks) {
    lines.push(`- ${item.status} ${item.id}: ${item.detail}`);
  }
  return lines.join("\n");
}
