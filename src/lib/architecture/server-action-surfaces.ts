/**
 * Inventario cerrado de archivos `use server`. Una entrada describe el limite
 * comun del archivo; `actions` enumera cada funcion exportada para que ninguna
 * mutacion aparezca sin revision al agregar codigo.
 */
export type ServerActionDomain = "identity" | "platform" | "workforce" | "expenses";
export type ServerActionTenantScope = "NONE" | "CONTROL_PLANE" | "EXPLICIT_COMPANY" | "RESOURCE_COMPANY" | "LEGACY_ARCOTEX";
export type ServerActionAuthentication =
  | "PUBLIC_AUTH_FLOW"
  | "SESSION"
  | "SESSION_PRIVILEGED"
  | "SESSION_MFA";
export type ServerActionValidation = "ZOD" | "DOMAIN_VALIDATED" | "MIXED_VALIDATION";
export type ServerActionAbuseControl =
  | "AUTH_PROVIDER_UNVERIFIED"
  | "DATABASE_RATE_LIMIT"
  | "DATABASE_QUOTA"
  | "DOMAIN_LIMITS_PARTIAL"
  | "MISSING";
export type ServerActionAuditControl =
  | "AUTH_PROVIDER"
  | "BUSINESS_LEDGER"
  | "MFA_LEDGER"
  | "PROVIDER_IDEMPOTENCY"
  | "PARTIAL"
  | "MISSING";
export type ServerActionBlocker =
  | "ANTIMALWARE_PROVIDER"
  | "APPLICATION_RATE_LIMIT"
  | "HOSTED_AUTH_CONTROLS"
  | "HOSTED_OBSERVABILITY"
  | "LABOR_MULTI_TENANCY";

export interface ServerActionFileSurface {
  readonly source: `src/app/${string}.ts`;
  readonly actions: readonly string[];
  readonly domain: ServerActionDomain;
  readonly tenantScope: ServerActionTenantScope;
  readonly authentication: ServerActionAuthentication;
  readonly authorizationEvidence: readonly string[];
  readonly validation: ServerActionValidation;
  readonly uploadMaxBytes: number | null;
  readonly abuseControl: ServerActionAbuseControl;
  readonly auditControl: ServerActionAuditControl;
  readonly dataClass: "AUTH" | "INTERNAL" | "PERSONAL" | "SENSITIVE_HR" | "FINANCIAL";
  readonly blockers: readonly ServerActionBlocker[];
}

const MIB = 1024 * 1024;

export const SERVER_ACTION_SURFACES = [
  {
    source: "src/app/login/actions.ts",
    actions: ["login", "loginWithGoogle", "logout"],
    domain: "identity", tenantScope: "NONE", authentication: "PUBLIC_AUTH_FLOW",
    authorizationEvidence: ["supabase.auth.signInWithPassword", "supabase.auth.signInWithOAuth", "supabase.auth.signOut"],
    validation: "ZOD", uploadMaxBytes: null, abuseControl: "AUTH_PROVIDER_UNVERIFIED",
    auditControl: "AUTH_PROVIDER", dataClass: "AUTH", blockers: ["HOSTED_AUTH_CONTROLS"],
  },
  {
    source: "src/app/login/mfa/actions.ts",
    actions: ["verifyMfaChallengeAction"],
    domain: "identity", tenantScope: "NONE", authentication: "SESSION_MFA",
    authorizationEvidence: ["getMfaAccountState", "challengeAndVerify"],
    validation: "ZOD", uploadMaxBytes: null, abuseControl: "AUTH_PROVIDER_UNVERIFIED",
    auditControl: "MFA_LEDGER", dataClass: "AUTH", blockers: ["HOSTED_AUTH_CONTROLS"],
  },
  {
    source: "src/app/seguridad/mfa/actions.ts",
    actions: ["startMfaEnrollmentAction", "confirmMfaEnrollmentAction", "discardMfaFactorAction", "mfaEnrollmentAction"],
    domain: "identity", tenantScope: "NONE", authentication: "SESSION_MFA",
    authorizationEvidence: ["getMfaAccountState", "mustChallengeBeforeChangingFactors"],
    validation: "ZOD", uploadMaxBytes: null, abuseControl: "AUTH_PROVIDER_UNVERIFIED",
    auditControl: "MFA_LEDGER", dataClass: "AUTH", blockers: ["HOSTED_AUTH_CONTROLS"],
  },
  {
    source: "src/app/(platform)/plataforma/actions.ts",
    actions: [
      "createCompanyAction", "inviteCompanyMemberAction", "resendCompanyInvitationAction",
      "assignCompanyRoleAction", "setCompanyModuleStatusAction", "setOnboardingStepStatusAction",
      "createOrganizationUnitAction", "resetMemberMfaAction",
    ],
    domain: "platform", tenantScope: "CONTROL_PLANE", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["requirePlatformManager"], validation: "ZOD", uploadMaxBytes: null,
    abuseControl: "DATABASE_RATE_LIMIT", auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/actions.ts",
    actions: [
      "createExpenseReportAction", "addExpenseItemAction", "deleteExpenseItemAction",
      "submitExpenseReportAction", "withdrawExpenseReportAction", "updateCategoryLimitsAction",
      "reconcileExpenseReportAction", "queueExpenseAccountingExportAction",
      "resolveExpenseAccountingExportAction", "matchExpenseBankTransactionAction",
      "ignoreExpenseBankTransactionAction", "uploadExpenseReceiptAction",
      "captureExpenseReceiptAction", "configureExpenseReceiptEmailAction",
      "configureExpenseReceiptWhatsappAction", "attachExpenseReceiptCaptureAction",
      "discardExpenseReceiptCaptureAction", "decideExpenseReportAction",
      "reviewExpenseReceiptOcrAction", "grantExpenseAdvanceAction", "settleExpenseAdvanceAction",
      "cancelExpenseAdvanceAction", "linkExpenseReportToAdvanceAction",
      "updateExpenseReportCostCenterAction",
    ],
    domain: "expenses", tenantScope: "EXPLICIT_COMPANY", authentication: "SESSION",
    authorizationEvidence: ["getExpenseCompanyContextFromClient"], validation: "ZOD",
    uploadMaxBytes: 10 * MIB, abuseControl: "DOMAIN_LIMITS_PARTIAL",
    auditControl: "BUSINESS_LEDGER", dataClass: "FINANCIAL", blockers: ["APPLICATION_RATE_LIMIT"],
  },
  {
    source: "src/app/(expenses)/empresas/[companySlug]/rendiciones/asistente/actions.ts",
    actions: ["runExpenseAssistantAction"],
    domain: "expenses", tenantScope: "EXPLICIT_COMPANY", authentication: "SESSION",
    authorizationEvidence: ["getExpenseCompanyContextFromClient"], validation: "ZOD",
    uploadMaxBytes: null, abuseControl: "DATABASE_QUOTA", auditControl: "BUSINESS_LEDGER",
    dataClass: "FINANCIAL", blockers: [],
  },
  {
    source: "src/app/(app)/colaciones/actions.ts",
    actions: ["parseMealMenuAction", "retryCreateGoogleFormAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["getCurrentProfile", "isPrivilegedAdmin"], validation: "MIXED_VALIDATION",
    uploadMaxBytes: 5 * MIB, abuseControl: "MISSING", auditControl: "PROVIDER_IDEMPOTENCY",
    dataClass: "PERSONAL", blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/colaciones/discount-workbook-actions.ts",
    actions: ["updateDiscountWorkbookAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["getCurrentProfile", "isPrivilegedAdmin"], validation: "DOMAIN_VALIDATED",
    uploadMaxBytes: 5 * MIB, abuseControl: "MISSING", auditControl: "PARTIAL",
    dataClass: "FINANCIAL", blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/configuracion/horarios/actions.ts",
    actions: ["assignScheduleAction", "assignScheduleToUnassignedAction", "setExemptionAction", "clearExemptionAction", "createScheduleAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["requireScheduleAdmin"], validation: "DOMAIN_VALIDATED", uploadMaxBytes: null,
    abuseControl: "MISSING", auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/configuracion/motor-de-reglas/actions.ts",
    actions: ["processAttendanceDayAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["getCurrentProfile", "runRuleEngineWithServiceRole"], validation: "DOMAIN_VALIDATED",
    uploadMaxBytes: null, abuseControl: "DOMAIN_LIMITS_PARTIAL", auditControl: "BUSINESS_LEDGER",
    dataClass: "SENSITIVE_HR", blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/(app)/documentos/actions.ts",
    actions: ["uploadGeneralDocumentAction"],
    domain: "workforce", tenantScope: "RESOURCE_COMPANY", authentication: "SESSION",
    authorizationEvidence: ["requireActiveProfile", "assertEmployeeAccessAllowed"], validation: "DOMAIN_VALIDATED", uploadMaxBytes: 10 * MIB,
    abuseControl: "DOMAIN_LIMITS_PARTIAL", auditControl: "PARTIAL", dataClass: "SENSITIVE_HR",
    blockers: ["ANTIMALWARE_PROVIDER"],
  },
  {
    source: "src/app/(app)/licencias/actions.ts",
    actions: ["uploadMedicalLicenseAction", "approveMedicalLicenseAction", "rejectMedicalLicenseAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["requireAuthenticatedProfile", "requireMedicalLicenseApprover"], validation: "DOMAIN_VALIDATED",
    uploadMaxBytes: 10 * MIB, abuseControl: "DOMAIN_LIMITS_PARTIAL", auditControl: "BUSINESS_LEDGER",
    dataClass: "SENSITIVE_HR", blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/licencias/roster-actions.ts",
    actions: ["previewPersonnelRosterAction", "applyPersonnelRosterAction", "runWorkeraRosterReconciliationAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["requireRosterAdmin"], validation: "DOMAIN_VALIDATED", uploadMaxBytes: 5 * MIB,
    abuseControl: "MISSING", auditControl: "PARTIAL", dataClass: "SENSITIVE_HR",
    blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY", "HOSTED_OBSERVABILITY"],
  },
  {
    source: "src/app/(app)/nomina-de-pago/actions.ts",
    actions: ["uploadSuppliersAction", "generatePayrollBatchAction", "previewSupplierMasterAction", "confirmSupplierMasterAction", "deactivateSupplierAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["requirePayrollAccess", "assertSecondFactorForPrivileged"], validation: "DOMAIN_VALIDATED",
    uploadMaxBytes: 5 * MIB, abuseControl: "MISSING", auditControl: "BUSINESS_LEDGER",
    dataClass: "FINANCIAL", blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/periodos/actions.ts",
    actions: ["createPeriodAction", "transitionPeriodAction"],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION_PRIVILEGED",
    authorizationEvidence: ["requirePeriodAdmin"], validation: "DOMAIN_VALIDATED", uploadMaxBytes: null,
    abuseControl: "MISSING", auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
  {
    source: "src/app/(app)/revision-diaria/actions.ts",
    actions: [
      "decideLateArrivalAction", "decideOvertimeAction", "markEarlyDepartureMedicalAction",
      "confirmEarlyDepartureMedicalDocumentAction", "decideEarlyDepartureOtherAction",
      "markAbsencePendingDocumentAction", "confirmAbsenceDocumentAction", "disputeAbsenceAction",
      "submitAttendanceCorrectionAction", "uploadDocumentAction",
    ],
    domain: "workforce", tenantScope: "LEGACY_ARCOTEX", authentication: "SESSION",
    authorizationEvidence: ["requireActiveProfile", "assertEmployeeAccessAllowed"], validation: "DOMAIN_VALIDATED", uploadMaxBytes: 10 * MIB,
    abuseControl: "DOMAIN_LIMITS_PARTIAL", auditControl: "BUSINESS_LEDGER", dataClass: "SENSITIVE_HR",
    blockers: ["APPLICATION_RATE_LIMIT", "LABOR_MULTI_TENANCY"],
  },
] as const satisfies readonly ServerActionFileSurface[];

export function serverActionSurfaceKey(surface: Pick<ServerActionFileSurface, "source">): string {
  return surface.source;
}
