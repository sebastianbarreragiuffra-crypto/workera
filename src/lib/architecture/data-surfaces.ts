/**
 * Registro cerrado de consumidores RPC y Storage del runtime. Complementa los
 * inventarios HTTP/Server Actions: una llamada nueva debe declarar identidad,
 * tenant, autorización, auditoría y deuda antes de entrar al producto.
 */
export type DataSurfaceDomain = "identity" | "platform" | "workforce" | "expenses";
export type DataExecutionIdentity = "SESSION" | "SERVICE_ROLE_CAPABILITY";
export type DataTenantScope =
  | "NONE"
  | "CONTROL_PLANE"
  | "EXPLICIT_COMPANY"
  | "RESOURCE_COMPANY"
  | "LEGACY_ARCOTEX"
  | "ROW_SCOPED_JOB"
  | "GLOBAL_MINIMIZED";
export type DataAuditControl =
  | "AUTH_PROVIDER"
  | "BUSINESS_LEDGER"
  | "PLATFORM_LEDGER"
  | "JOB_LEDGER"
  | "PROVIDER_LEDGER"
  | "DATA_ACCESS_LEDGER"
  | "PARTIAL"
  | "NOT_APPLICABLE";
export type DataSurfaceBlocker =
  | "ANTIMALWARE_PROVIDER"
  | "APPLICATION_RATE_LIMIT"
  | "EDGE_RATE_LIMIT"
  | "HOSTED_MFA_ROLLOUT"
  | "HOSTED_OBSERVABILITY"
  | "LABOR_MULTI_TENANCY";

export interface RpcConsumerSurface {
  readonly source: `src/${string}.ts`;
  readonly domain: DataSurfaceDomain;
  readonly executionIdentity: DataExecutionIdentity;
  readonly capability: string | null;
  readonly tenantScope: DataTenantScope;
  readonly literalRpcs: readonly string[];
  readonly dynamicRpcs: readonly string[];
  readonly authorization: string;
  readonly auditControl: DataAuditControl;
  readonly dataClass: "AUTH" | "INTERNAL" | "PERSONAL" | "SENSITIVE_HR" | "FINANCIAL";
  readonly blockers: readonly DataSurfaceBlocker[];
}

export const RPC_CONSUMER_SURFACES = [
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/actions.ts",
    domain: "expenses", executionIdentity: "SESSION", capability: null, tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: [
      "attach_expense_receipt_capture", "begin_expense_receipt_whatsapp_pairing",
      "cancel_expense_advance", "create_expense_report", "decide_expense_report",
      "disconnect_expense_receipt_whatsapp", "grant_expense_advance",
      "ignore_expense_bank_transaction", "link_expense_report_to_advance",
      "match_expense_bank_transaction", "queue_expense_accounting_export",
      "reconcile_expense_report", "resolve_expense_accounting_export",
      "review_expense_receipt_extraction", "settle_expense_advance",
      "submit_expense_report", "withdraw_expense_report",
    ],
    dynamicRpcs: ["ensure_expense_receipt_email_alias", "rotate_expense_receipt_email_alias"],
    authorization: "Contexto de empresa y permiso por acción; cada RPC revalida actor/tenant.",
    auditControl: "BUSINESS_LEDGER", dataClass: "FINANCIAL", blockers: ["APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/app/(platform)/plataforma/actions.ts",
    domain: "platform", executionIdentity: "SESSION", capability: null, tenantScope: "CONTROL_PLANE",
    literalRpcs: [
      "platform_assign_company_role", "platform_create_company",
      "platform_create_company_invitation", "platform_create_organization_unit",
      "platform_mark_company_invitation_delivery", "platform_set_company_module_status",
      "platform_set_onboarding_step_completed",
    ],
    dynamicRpcs: [], authorization: "requirePlatformManager y AAL2; RPC repite permiso de plataforma.",
    auditControl: "PLATFORM_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/admin/mfa-reset.ts",
    domain: "identity", executionIdentity: "SESSION", capability: null, tenantScope: "CONTROL_PLANE",
    literalRpcs: ["can_reset_mfa_for"], dynamicRpcs: [],
    authorization: "Sesión AAL2 y regla owner-only antes de usar Auth Admin.",
    auditControl: "PARTIAL", dataClass: "AUTH", blockers: ["HOSTED_MFA_ROLLOUT"],
  },
  {
    source: "src/lib/business-rules/process-attendance-day.ts",
    domain: "workforce", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "attendance-rule-engine",
    tenantScope: "LEGACY_ARCOTEX", literalRpcs: ["reclaim_stale_rule_engine_runs"], dynamicRpcs: [],
    authorization: "Solo wrapper del motor, invocado por cron o acción que autorizó previamente.",
    auditControl: "JOB_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/colaciones/discount-workbook-storage.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "LEGACY_ARCOTEX",
    literalRpcs: ["activate_colaciones_discount_workbook"], dynamicRpcs: [],
    authorization: "Acción RRHH privilegiada; RPC valida actor y activa una sola versión.",
    auditControl: "PARTIAL", dataClass: "FINANCIAL",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/lib/decisions/document-download.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "RESOURCE_COMPANY",
    literalRpcs: ["authorize_supporting_document_download"], dynamicRpcs: [],
    authorization: "RPC deriva empresa y exige rol, membresía, MFA, recurso y cuota.",
    auditControl: "DATA_ACCESS_LEDGER", dataClass: "SENSITIVE_HR", blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/decisions/documents.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "RESOURCE_COMPANY",
    literalRpcs: ["register_supporting_document_upload", "reserve_supporting_document_upload"], dynamicRpcs: [],
    authorization: "Reserva y commit revalidan trabajador, membresía, MFA, bytes y relación.",
    auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR", blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/decisions/medical-license.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "LEGACY_ARCOTEX",
    literalRpcs: ["approve_medical_license", "create_pending_medical_license", "reject_medical_license"], dynamicRpcs: [],
    authorization: "Carga atómica y transiciones maker-checker con aprobador dedicado.",
    auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/lib/decisions/workforce-data-access.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "LEGACY_ARCOTEX",
    literalRpcs: ["authorize_workforce_data_access"], dynamicRpcs: [],
    authorization: "RPC deriva ARCOTEX y exige membresía, rol, MFA, recurso/período y cuota.",
    auditControl: "DATA_ACCESS_LEDGER", dataClass: "FINANCIAL", blockers: ["LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/lib/employees/personnel-roster-import.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "LEGACY_ARCOTEX",
    literalRpcs: ["apply_personnel_roster_import"], dynamicRpcs: [],
    authorization: "Acción RRHH y RPC de aplicación transaccional.", auditControl: "PARTIAL",
    dataClass: "SENSITIVE_HR", blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/expense-accounting/repository.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-accounting-worker",
    tenantScope: "ROW_SCOPED_JOB",
    literalRpcs: [
      "claim_expense_accounting_exports", "complete_expense_accounting_export",
      "complete_expense_accounting_worker_run", "get_expense_accounting_worker_health",
      "start_expense_accounting_worker_run",
    ],
    dynamicRpcs: [], authorization: "CRON_SECRET/flag y leases fenced; cliente inyectado por servicio capability-scoped.",
    auditControl: "JOB_LEDGER", dataClass: "FINANCIAL", blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/expense-assistant/service.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-assistant-retention",
    tenantScope: "GLOBAL_MINIMIZED", literalRpcs: ["purge_expired_expense_assistant_queries"], dynamicRpcs: [],
    authorization: "Solo cron autenticado; RPC limitada a borrar consultas vencidas.",
    auditControl: "PARTIAL", dataClass: "INTERNAL", blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/expense-bank/service.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-bank-import",
    tenantScope: "EXPLICIT_COMPANY", literalRpcs: ["claim_expense_bank_upload", "import_expense_bank_statement"], dynamicRpcs: [],
    authorization: "Handler valida sesión/permiso; RPC revalida actor, empresa, cuota e idempotencia.",
    auditControl: "BUSINESS_LEDGER", dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/lib/expense-capture/service.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-receipt-storage",
    tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: [
      "discard_expense_receipt_capture", "register_expense_receipt_capture",
      "register_expense_receipt_trusted", "register_expense_receipt_whatsapp_capture",
      "register_inbound_expense_receipt_capture",
    ],
    dynamicRpcs: [], authorization: "Actor/tenant validados antes del capability; RPC aplica cuota, estado y relaciones.",
    auditControl: "BUSINESS_LEDGER", dataClass: "FINANCIAL", blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/expense-email/service.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-email-ingestion",
    tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: [
      "claim_expense_receipt_email_event", "complete_expense_receipt_email_event",
      "release_expense_receipt_email_event", "reserve_expense_receipt_email_bytes",
      "resolve_expense_receipt_email_alias",
    ],
    dynamicRpcs: [], authorization: "Webhook firmado, alias opaco, lease y cuota antes de almacenar.",
    auditControl: "PROVIDER_LEDGER", dataClass: "FINANCIAL", blockers: ["EDGE_RATE_LIMIT", "ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/expense-ocr/repository.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-ocr-worker",
    tenantScope: "ROW_SCOPED_JOB",
    literalRpcs: [
      "claim_expense_ocr_jobs", "complete_expense_ocr_job", "defer_expense_ocr_job",
      "fail_expense_ocr_job", "reclaim_stale_expense_ocr_jobs",
    ],
    dynamicRpcs: [], authorization: "CRON_SECRET/flag y RPC con lease/fencing; archivo solo CLEAN.",
    auditControl: "JOB_LEDGER", dataClass: "FINANCIAL", blockers: ["ANTIMALWARE_PROVIDER", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/expense-whatsapp/service.ts",
    domain: "expenses", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "expense-whatsapp-ingestion",
    tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: [
      "claim_expense_receipt_whatsapp_event", "claim_expense_receipt_whatsapp_pairing",
      "reserve_expense_receipt_whatsapp_bytes", "resolve_expense_receipt_whatsapp_sender",
    ],
    dynamicRpcs: ["complete_expense_receipt_whatsapp_event", "release_expense_receipt_whatsapp_event"],
    authorization: "Firma Meta, phone id, vínculo opaco, lease y cuota antes de almacenar.",
    auditControl: "PROVIDER_LEDGER", dataClass: "FINANCIAL", blockers: ["EDGE_RATE_LIMIT", "ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/expenses/access.ts",
    domain: "expenses", executionIdentity: "SESSION", capability: null, tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: ["has_company_permission"], dynamicRpcs: [],
    authorization: "Resuelve permisos de la membresía activa del actor actual.",
    auditControl: "NOT_APPLICABLE", dataClass: "INTERNAL", blockers: [],
  },
  {
    source: "src/lib/expenses/assistant.ts",
    domain: "expenses", executionIdentity: "SESSION", capability: null, tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: ["run_expense_readonly_assistant"], dynamicRpcs: [],
    authorization: "Contexto tenant, permiso y presupuesto diario dentro del RPC read-only.",
    auditControl: "BUSINESS_LEDGER", dataClass: "FINANCIAL", blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/expenses/data-access-guard.ts",
    domain: "expenses", executionIdentity: "SESSION", capability: null, tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: ["authorize_expense_data_access"], dynamicRpcs: [],
    authorization: "RPC revalida recurso, permiso, cuarentena y cuota.",
    auditControl: "DATA_ACCESS_LEDGER", dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/lib/expenses/data.ts",
    domain: "expenses", executionIdentity: "SESSION", capability: null, tenantScope: "EXPLICIT_COMPANY",
    literalRpcs: [
      "expense_dashboard_summary", "get_expense_accounting_company_health",
      "get_expense_indicators", "list_expense_accounting_ready_reports",
      "list_expense_reconciliation_candidates",
    ],
    dynamicRpcs: [], authorization: "Contexto de empresa previo y RPCs con company_id/permiso.",
    auditControl: "NOT_APPLICABLE", dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/lib/payroll/supplier-master.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "LEGACY_ARCOTEX",
    literalRpcs: ["apply_supplier_master_import"], dynamicRpcs: [],
    authorization: "Acción privilegiada y RPC transaccional; Storage privado.",
    auditControl: "BUSINESS_LEDGER", dataClass: "FINANCIAL",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/lib/platform/action-rate-limit.ts",
    domain: "platform", executionIdentity: "SESSION", capability: null, tenantScope: "CONTROL_PLANE",
    literalRpcs: ["consume_platform_action_rate_limit"], dynamicRpcs: [],
    authorization: "Scope cerrado; RPC exige actor, rol, MFA, empresa/recurso y cuota por instancia compartida.",
    auditControl: "PLATFORM_LEDGER", dataClass: "SENSITIVE_HR", blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/platform/invitations.ts",
    domain: "platform", executionIdentity: "SESSION", capability: null, tenantScope: "CONTROL_PLANE",
    literalRpcs: ["accept_my_company_invitations"], dynamicRpcs: [],
    authorization: "Actor deriva de auth.uid y solo acepta invitaciones vigentes para su identidad.",
    auditControl: "PLATFORM_LEDGER", dataClass: "SENSITIVE_HR", blockers: [],
  },
  {
    source: "src/lib/platform/portfolio.ts",
    domain: "platform", executionIdentity: "SESSION", capability: null, tenantScope: "CONTROL_PLANE",
    literalRpcs: ["platform_company_organization", "platform_company_portfolio_page", "platform_portfolio_summary"], dynamicRpcs: [],
    authorization: "Membresía de plataforma y proyecciones agregadas/minimizadas.",
    auditControl: "NOT_APPLICABLE", dataClass: "INTERNAL", blockers: [],
  },
  {
    source: "src/lib/schedules/schedule-administration.ts",
    domain: "workforce", executionIdentity: "SESSION", capability: null, tenantScope: "LEGACY_ARCOTEX",
    literalRpcs: [
      "apply_schedule_assignment", "assign_schedule_to_unassigned",
      "clear_time_control_exemption", "set_time_control_exemption", "upsert_work_schedule",
    ],
    dynamicRpcs: [], authorization: "Acción RRHH; RPCs revalidan rol y precondiciones.",
    auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/lib/supabase/middleware.ts",
    domain: "identity", executionIdentity: "SESSION", capability: null, tenantScope: "NONE",
    literalRpcs: ["session_requires_mfa"], dynamicRpcs: [],
    authorization: "JWT actual; respuesta fail-closed determina redirección AAL2.",
    auditControl: "AUTH_PROVIDER", dataClass: "AUTH", blockers: ["HOSTED_MFA_ROLLOUT"],
  },
  {
    source: "src/lib/sync/scheduler.ts",
    domain: "workforce", executionIdentity: "SERVICE_ROLE_CAPABILITY", capability: "workera-attendance-sync",
    tenantScope: "LEGACY_ARCOTEX", literalRpcs: ["reclaim_stale_workera_sync_runs"], dynamicRpcs: [],
    authorization: "Cron secret o rerun autorizado antes del capability; lease de sync.",
    auditControl: "JOB_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["LABOR_MULTI_TENANCY", "HOSTED_OBSERVABILITY"],
  },
] as const satisfies readonly RpcConsumerSurface[];

export type StorageOperation = "upload" | "download" | "remove" | "createSignedUrl";
export type StorageSecurityState = "QUARANTINE_ENFORCED" | "PRIVATE_UNSCANNED" | "TRUSTED_INTERNAL_SOURCE";
export interface StorageConsumerSurface {
  readonly source: `src/${string}.ts`;
  readonly bucket: string;
  readonly operation: StorageOperation;
  readonly occurrences: number;
  readonly executionIdentity: DataExecutionIdentity;
  readonly tenantScope: DataTenantScope;
  readonly authorization: string;
  readonly securityState: StorageSecurityState;
  readonly blockers: readonly DataSurfaceBlocker[];
}

export const STORAGE_CONSUMER_SURFACES = [
  {
    source: "src/app/(app)/licencias/documento/[documentId]/route.ts", bucket: "supporting-documents", operation: "download", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "RESOURCE_COMPANY",
    authorization: "RPC + Storage policy repiten rol, empresa y MFA; respuesta attachment.",
    securityState: "PRIVATE_UNSCANNED", blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/app/(app)/nomina-de-pago/proveedores/descargar/route.ts", bucket: "supplier-master-files", operation: "download", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "LEGACY_ARCOTEX",
    authorization: "RPC, MFA, cuota y policy revalidan el maestro ACTIVE; respuesta attachment.", securityState: "TRUSTED_INTERNAL_SOURCE",
    blockers: ["LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/comprobantes/[receiptId]/route.ts", bucket: "expense-receipts", operation: "createSignedUrl", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Guard de entrega + RLS solo para archivo CLEAN.", securityState: "QUARANTINE_ENFORCED", blockers: [],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/comprobantes/capturas/[captureId]/route.ts", bucket: "expense-receipts", operation: "createSignedUrl", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Propietario + guard de entrega + RLS solo para archivo CLEAN.", securityState: "QUARANTINE_ENFORCED", blockers: [],
  },
  {
    source: "src/lib/colaciones/discount-workbook-storage.ts", bucket: "colaciones-config-files", operation: "download", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "LEGACY_ARCOTEX",
    authorization: "RLS RRHH sobre dataset interno activo.", securityState: "TRUSTED_INTERNAL_SOURCE",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/lib/colaciones/discount-workbook-storage.ts", bucket: "colaciones-config-files", operation: "upload", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "LEGACY_ARCOTEX",
    authorization: "Acción RRHH, validación XLSX y policy privada.", securityState: "TRUSTED_INTERNAL_SOURCE",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/lib/decisions/documents.ts", bucket: "supporting-documents", operation: "upload", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "RESOURCE_COMPANY",
    authorization: "Reserva opaca exacta por actor/empleado/tamaño/MIME.", securityState: "PRIVATE_UNSCANNED",
    blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/decisions/documents.ts", bucket: "supporting-documents", operation: "remove", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "RESOURCE_COMPANY",
    authorization: "Policy permite solo compensar reserva propia aún no registrada.", securityState: "PRIVATE_UNSCANNED",
    blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/expense-capture/service.ts", bucket: "expense-receipts", operation: "upload", occurrences: 1,
    executionIdentity: "SERVICE_ROLE_CAPABILITY", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Capability cerrado y registro tenant-aware en PENDING_SCAN.", securityState: "QUARANTINE_ENFORCED",
    blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/expense-capture/service.ts", bucket: "expense-receipts", operation: "remove", occurrences: 2,
    executionIdentity: "SERVICE_ROLE_CAPABILITY", tenantScope: "EXPLICIT_COMPANY",
    authorization: "Compensación o descarte después de RPC que devuelve ruta validada.", securityState: "QUARANTINE_ENFORCED",
    blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/lib/expense-ocr/repository.ts", bucket: "expense-receipts", operation: "download", occurrences: 1,
    executionIdentity: "SERVICE_ROLE_CAPABILITY", tenantScope: "ROW_SCOPED_JOB",
    authorization: "Job fenced solo recibe ruta de recibo CLEAN reclamada por RPC.", securityState: "QUARANTINE_ENFORCED",
    blockers: ["ANTIMALWARE_PROVIDER", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/lib/payroll/supplier-master.ts", bucket: "supplier-master-files", operation: "upload", occurrences: 1,
    executionIdentity: "SESSION", tenantScope: "LEGACY_ARCOTEX",
    authorization: "Acción RRHH, parser XLSX y policy privada.", securityState: "TRUSTED_INTERNAL_SOURCE",
    blockers: ["LABOR_MULTI_TENANCY", "APPLICATION_RATE_LIMIT"],
  },
] as const satisfies readonly StorageConsumerSurface[];

export function storageConsumerKey(
  surface: Pick<StorageConsumerSurface, "source" | "bucket" | "operation">,
): string {
  return `${surface.source}|${surface.bucket}|${surface.operation}`;
}
