/**
 * Inventario cerrado de Route Handlers. Es una pieza de gobierno ejecutable:
 * agregar una ruta o un método HTTP sin describir sus controles rompe CI.
 *
 * `blockers` registra brechas reales; estar en este inventario no significa que
 * la superficie esté autorizada para producción. Los gates globales de P0
 * (MFA, restore, staging sintético, observabilidad y aceptación de riesgo)
 * siguen aplicando aunque un arreglo quede vacío.
 */
export type RequestSurfaceDomain = "identity" | "platform" | "workforce" | "expenses";
export type RequestSurfaceKind = "AUTH_CALLBACK" | "USER_API" | "DOWNLOAD" | "CRON_JOB" | "WEBHOOK";
export type RequestAuthentication =
  | "PUBLIC_PROVIDER_TOKEN"
  | "SESSION"
  | "SESSION_PRIVILEGED_ROLE"
  | "CRON_SECRET"
  | "WEBHOOK_SIGNATURE"
  | "WEBHOOK_CHALLENGE";
export type RequestTenantScope =
  | "NONE"
  | "CONTROL_PLANE"
  | "EXPLICIT_COMPANY"
  | "RESOURCE_COMPANY"
  | "LEGACY_ARCOTEX"
  | "ROW_SCOPED_JOB"
  | "GLOBAL_MINIMIZED";
export type RequestAbuseControl =
  | "AUTH_PROVIDER_UNVERIFIED"
  | "CRON_SECRET_AND_LEASE"
  | "DATABASE_QUOTA"
  | "DATABASE_RATE_LIMIT"
  | "PROVIDER_LEDGER_AND_QUOTA"
  | "READ_ONLY_NO_LIMIT"
  | "MISSING"
  | "NOT_APPLICABLE";
export type RequestAuditControl =
  | "AUTH_PROVIDER"
  | "BUSINESS_LEDGER"
  | "DATA_ACCESS_LEDGER"
  | "JOB_LEDGER"
  | "PROVIDER_LEDGER"
  | "MISSING"
  | "NOT_APPLICABLE";
export type RequestIdempotency =
  | "PROVIDER_TOKEN"
  | "DATABASE_CONSTRAINT"
  | "LEASE_AND_FENCING"
  | "PROVIDER_EVENT_LEDGER"
  | "IDEMPOTENT_DELETE"
  | "READ_ONLY"
  | "NOT_APPLICABLE";
export type RequestDataClass = "PUBLIC" | "AUTH" | "INTERNAL" | "PERSONAL" | "SENSITIVE_HR" | "FINANCIAL";
export type RequestSurfaceBlocker =
  | "ANTIMALWARE_PROVIDER"
  | "APPLICATION_RATE_LIMIT"
  | "EDGE_RATE_LIMIT"
  | "EXPORT_AUDIT"
  | "HOSTED_AUTH_CONTROLS"
  | "HOSTED_OBSERVABILITY"
  | "LABOR_MULTI_TENANCY";

export interface RequestSurface {
  readonly source: `src/app/${string}/route.ts`;
  readonly route: `/${string}`;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  readonly kind: RequestSurfaceKind;
  readonly domain: RequestSurfaceDomain;
  readonly authentication: RequestAuthentication;
  readonly tenantScope: RequestTenantScope;
  readonly authorization: string;
  readonly mutates: boolean;
  readonly maxBodyBytes: number | null;
  readonly idempotency: RequestIdempotency;
  readonly abuseControl: RequestAbuseControl;
  readonly auditControl: RequestAuditControl;
  readonly featureFlag: string | null;
  readonly dataClass: RequestDataClass;
  readonly blockers: readonly RequestSurfaceBlocker[];
}

const MIB = 1024 * 1024;

export const REQUEST_SURFACES = [
  {
    source: "src/app/auth/confirm/route.ts", route: "/auth/confirm", method: "GET", kind: "AUTH_CALLBACK",
    domain: "identity", authentication: "PUBLIC_PROVIDER_TOKEN", tenantScope: "NONE",
    authorization: "Supabase verifyOtp consume un token firmado y de uso único; next acepta solo rutas locales.",
    mutates: true, maxBodyBytes: null, idempotency: "PROVIDER_TOKEN", abuseControl: "AUTH_PROVIDER_UNVERIFIED",
    auditControl: "AUTH_PROVIDER", featureFlag: null, dataClass: "AUTH", blockers: ["HOSTED_AUTH_CONTROLS"],
  },
  {
    source: "src/app/auth/callback/route.ts", route: "/auth/callback", method: "GET", kind: "AUTH_CALLBACK",
    domain: "identity", authentication: "PUBLIC_PROVIDER_TOKEN", tenantScope: "NONE",
    authorization: "Supabase exchangeCodeForSession valida el código OAuth; destino post-login falla cerrado hacia MFA.",
    mutates: true, maxBodyBytes: null, idempotency: "PROVIDER_TOKEN", abuseControl: "AUTH_PROVIDER_UNVERIFIED",
    auditControl: "AUTH_PROVIDER", featureFlag: null, dataClass: "AUTH", blockers: ["HOSTED_AUTH_CONTROLS"],
  },
  {
    source: "src/app/api/sync/workera/route.ts", route: "/api/sync/workera", method: "GET", kind: "CRON_JOB",
    domain: "workforce", authentication: "CRON_SECRET", tenantScope: "LEGACY_ARCOTEX",
    authorization: "Bearer CRON_SECRET fuerte; el handler revalida sin confiar en middleware.",
    mutates: true, maxBodyBytes: null, idempotency: "LEASE_AND_FENCING", abuseControl: "CRON_SECRET_AND_LEASE",
    auditControl: "JOB_LEDGER", featureFlag: "WORKERA_SYNC_ENABLED", dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/api/sync/workera/route.ts", route: "/api/sync/workera", method: "POST", kind: "USER_API",
    domain: "workforce", authentication: "SESSION_PRIVILEGED_ROLE", tenantScope: "LEGACY_ARCOTEX",
    authorization: "Cuota deriva ARCOTEX y exige rol/MFA; rerunWorkeraSync repite rol y acota el rango.",
    mutates: true, maxBodyBytes: 1024, idempotency: "LEASE_AND_FENCING", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "JOB_LEDGER", featureFlag: null, dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/api/jobs/expense-ocr/route.ts", route: "/api/jobs/expense-ocr", method: "GET", kind: "CRON_JOB",
    domain: "expenses", authentication: "CRON_SECRET", tenantScope: "ROW_SCOPED_JOB",
    authorization: "Bearer CRON_SECRET y claims fenced de la cola OCR.",
    mutates: true, maxBodyBytes: null, idempotency: "LEASE_AND_FENCING", abuseControl: "CRON_SECRET_AND_LEASE",
    auditControl: "JOB_LEDGER", featureFlag: "EXPENSE_OCR_ENABLED", dataClass: "FINANCIAL",
    blockers: ["ANTIMALWARE_PROVIDER", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/api/jobs/expense-file-scan/route.ts", route: "/api/jobs/expense-file-scan", method: "GET", kind: "CRON_JOB",
    domain: "expenses", authentication: "CRON_SECRET", tenantScope: "ROW_SCOPED_JOB",
    authorization: "Bearer CRON_SECRET, flag fail-closed y claims fenced de la cuarentena.",
    mutates: true, maxBodyBytes: null, idempotency: "LEASE_AND_FENCING", abuseControl: "CRON_SECRET_AND_LEASE",
    auditControl: "JOB_LEDGER", featureFlag: "EXPENSE_FILE_SCAN_ENABLED", dataClass: "FINANCIAL",
    blockers: ["ANTIMALWARE_PROVIDER", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/api/jobs/expense-assistant-retention/route.ts", route: "/api/jobs/expense-assistant-retention", method: "GET", kind: "CRON_JOB",
    domain: "expenses", authentication: "CRON_SECRET", tenantScope: "GLOBAL_MINIMIZED",
    authorization: "Bearer CRON_SECRET; RPC limitada a purgar consultas expiradas.",
    mutates: true, maxBodyBytes: null, idempotency: "IDEMPOTENT_DELETE", abuseControl: "CRON_SECRET_AND_LEASE",
    auditControl: "MISSING", featureFlag: null, dataClass: "INTERNAL", blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/api/jobs/expense-accounting/route.ts", route: "/api/jobs/expense-accounting", method: "GET", kind: "CRON_JOB",
    domain: "expenses", authentication: "CRON_SECRET", tenantScope: "ROW_SCOPED_JOB",
    authorization: "Bearer CRON_SECRET, feature flag y RPC de outbox fenced.",
    mutates: true, maxBodyBytes: null, idempotency: "LEASE_AND_FENCING", abuseControl: "CRON_SECRET_AND_LEASE",
    auditControl: "JOB_LEDGER", featureFlag: "EXPENSE_ACCOUNTING_EXPORT_ENABLED", dataClass: "FINANCIAL",
    blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/api/jobs/expense-accounting-watchdog/route.ts", route: "/api/jobs/expense-accounting-watchdog", method: "GET", kind: "CRON_JOB",
    domain: "expenses", authentication: "CRON_SECRET", tenantScope: "ROW_SCOPED_JOB",
    authorization: "Bearer CRON_SECRET; solo consulta la proyección agregada de salud del outbox.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "CRON_SECRET_AND_LEASE",
    auditControl: "JOB_LEDGER", featureFlag: null, dataClass: "INTERNAL", blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/api/webhooks/meta/expense-receipts/route.ts", route: "/api/webhooks/meta/expense-receipts", method: "GET", kind: "WEBHOOK",
    domain: "expenses", authentication: "WEBHOOK_CHALLENGE", tenantScope: "NONE",
    authorization: "Verify token comparado en tiempo constante y challenge estrictamente numérico.",
    mutates: false, maxBodyBytes: null, idempotency: "NOT_APPLICABLE", abuseControl: "READ_ONLY_NO_LIMIT",
    auditControl: "NOT_APPLICABLE", featureFlag: null, dataClass: "PUBLIC", blockers: ["EDGE_RATE_LIMIT"],
  },
  {
    source: "src/app/api/webhooks/meta/expense-receipts/route.ts", route: "/api/webhooks/meta/expense-receipts", method: "POST", kind: "WEBHOOK",
    domain: "expenses", authentication: "WEBHOOK_SIGNATURE", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Firma HMAC Meta sobre bytes crudos, phone_number_id y vínculo opaco tenant-aware.",
    mutates: true, maxBodyBytes: 512 * 1024, idempotency: "PROVIDER_EVENT_LEDGER", abuseControl: "PROVIDER_LEDGER_AND_QUOTA",
    auditControl: "PROVIDER_LEDGER", featureFlag: "EXPENSE_WHATSAPP_CAPTURE_ENABLED", dataClass: "FINANCIAL",
    blockers: ["EDGE_RATE_LIMIT", "ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/app/api/webhooks/resend/expense-receipts/route.ts", route: "/api/webhooks/resend/expense-receipts", method: "POST", kind: "WEBHOOK",
    domain: "expenses", authentication: "WEBHOOK_SIGNATURE", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Firma Svix/Resend sobre cuerpo crudo y alias opaco tenant-aware.",
    mutates: true, maxBodyBytes: 512 * 1024, idempotency: "PROVIDER_EVENT_LEDGER", abuseControl: "PROVIDER_LEDGER_AND_QUOTA",
    auditControl: "PROVIDER_LEDGER", featureFlag: "EXPENSE_EMAIL_CAPTURE_ENABLED", dataClass: "FINANCIAL",
    blockers: ["EDGE_RATE_LIMIT", "ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/app/api/expenses/[companySlug]/bank-import/route.ts", route: "/api/expenses/[companySlug]/bank-import", method: "POST", kind: "USER_API",
    domain: "expenses", authentication: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Contexto de empresa, entitlement, canReconcile, same-origin y RPC que revalida actor/empresa.",
    mutates: true, maxBodyBytes: 2 * MIB, idempotency: "DATABASE_CONSTRAINT", abuseControl: "DATABASE_QUOTA",
    auditControl: "BUSINESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/app/(app)/nomina-de-pago/export/[batchId]/route.ts", route: "/nomina-de-pago/export/[batchId]", method: "GET", kind: "DOWNLOAD",
    domain: "workforce", authentication: "SESSION_PRIVILEGED_ROLE", tenantScope: "LEGACY_ARCOTEX",
    authorization: "SUPER_ADMIN/ADMIN_RRHH; RPC deriva ARCOTEX y revalida membresía, MFA, lote y cuota.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL",
    blockers: ["LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/dashboard/export-asistencia/route.ts", route: "/dashboard/export-asistencia", method: "GET", kind: "DOWNLOAD",
    domain: "workforce", authentication: "SESSION", tenantScope: "LEGACY_ARCOTEX",
    authorization: "Perfil y áreas; RPC deriva ARCOTEX y revalida membresía, MFA, período y cuota.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/nomina-de-pago/proveedores/descargar/route.ts", route: "/nomina-de-pago/proveedores/descargar", method: "GET", kind: "DOWNLOAD",
    domain: "workforce", authentication: "SESSION_PRIVILEGED_ROLE", tenantScope: "LEGACY_ARCOTEX",
    authorization: "SUPER_ADMIN/ADMIN_RRHH; RPC y Storage revalidan ARCOTEX, MFA, fila ACTIVE y cuota; sin signed URL.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL",
    blockers: ["LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/licencias/documento/[documentId]/route.ts", route: "/licencias/documento/[documentId]", method: "GET", kind: "DOWNLOAD",
    domain: "workforce", authentication: "SESSION_PRIVILEGED_ROLE", tenantScope: "RESOURCE_COMPANY",
    authorization: "Rol privilegiado; RPC y Storage revalidan MFA, documento y membresia en la empresa del trabajador.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "SENSITIVE_HR",
    blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/contabilidad/[exportId]/csv/route.ts", route: "/empresas/[companySlug]/rendiciones/contabilidad/[exportId]/csv", method: "GET", kind: "DOWNLOAD",
    domain: "expenses", authentication: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Contexto tenant, canReconcile, UUID y company_id en la consulta.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/comprobantes/[receiptId]/route.ts", route: "/empresas/[companySlug]/rendiciones/comprobantes/[receiptId]", method: "GET", kind: "DOWNLOAD",
    domain: "expenses", authentication: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Contexto tenant, UUID, company_id, RLS y URL privada firmada por 60 segundos.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/conciliacion/exportar/route.ts", route: "/empresas/[companySlug]/rendiciones/conciliacion/exportar", method: "GET", kind: "DOWNLOAD",
    domain: "expenses", authentication: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Contexto tenant, canReconcile y queries company-scoped.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/comprobantes/capturas/[captureId]/route.ts", route: "/empresas/[companySlug]/rendiciones/comprobantes/capturas/[captureId]", method: "GET", kind: "DOWNLOAD",
    domain: "expenses", authentication: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Contexto tenant con canSubmit, propietario, estado PENDING, company_id y URL firmada.",
    mutates: false, maxBodyBytes: null, idempotency: "READ_ONLY", abuseControl: "DATABASE_RATE_LIMIT",
    auditControl: "DATA_ACCESS_LEDGER", featureFlag: null, dataClass: "FINANCIAL", blockers: [],
  },
] as const satisfies readonly RequestSurface[];

export function requestSurfaceKey(surface: Pick<RequestSurface, "method" | "route">): string {
  return `${surface.method} ${surface.route}`;
}
