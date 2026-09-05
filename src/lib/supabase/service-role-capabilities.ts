import "server-only";

/**
 * Inventario cerrado de los consumidores de `service_role`.
 *
 * Este registro no convierte la clave compartida en credenciales distintas:
 * documenta y hace comprobable su blast radius actual. Cada consumidor nuevo
 * debe declarar un identificador, su límite server-only, la autoridad que se
 * comprueba antes de usarlo y los recursos privilegiados que alcanza.
 */
export const SERVICE_ROLE_CAPABILITIES = {
  "auth-user-provisioning": {
    consumers: ["src/lib/admin/user-management.ts"],
    entrypoints: ["USER_ACTION"],
    authorization: "requireAppAdmin() sobre la sesión real antes de crear el cliente administrativo.",
    resources: ["Supabase Auth admin.createUser"],
  },
  "company-invitation-delivery": {
    consumers: ["src/lib/admin/company-invitations.ts"],
    entrypoints: ["USER_ACTION"],
    authorization: "La acción de plataforma autoriza y registra la invitación antes de solicitar el envío.",
    resources: ["Supabase Auth admin.inviteUserByEmail"],
  },
  "mfa-factor-administration": {
    consumers: ["src/lib/admin/mfa-reset.ts"],
    entrypoints: ["USER_ACTION"],
    authorization: "Sesión aal2 y can_reset_mfa_for() antes de listar o eliminar factores.",
    resources: ["Supabase Auth admin.mfa.listFactors", "Supabase Auth admin.mfa.deleteFactor"],
  },
  "mfa-audit-log": {
    consumers: ["src/lib/admin/mfa-audit.ts"],
    entrypoints: ["USER_ACTION", "INTERNAL"],
    authorization: "Solo recibe eventos tipados desde flujos MFA ya autenticados; la tabla es append-only.",
    resources: ["public.mfa_events INSERT"],
  },
  "workera-attendance-sync": {
    consumers: ["src/lib/sync/scheduler.ts", "src/lib/sync/workera-attendance-sync.ts"],
    entrypoints: ["CRON", "USER_ACTION"],
    authorization: "CRON_SECRET para el job o requireCurrentRole() para el rerun manual; RPC y company_id revalidan el alcance.",
    resources: ["sync_runs", "workera_attendance_events", "employees", "RPC de sync y recuperación"],
  },
  "attendance-rule-engine": {
    consumers: ["src/lib/rule-engine/service.ts"],
    entrypoints: ["CRON", "USER_ACTION", "INTERNAL"],
    authorization: "El llamador autoriza antes del límite; la rederivación queda acotada a fecha y empleado.",
    resources: ["rule_engine_runs", "hechos derivados de asistencia"],
  },
  "expense-ocr-worker": {
    consumers: ["src/lib/expense-ocr/service.ts"],
    entrypoints: ["CRON"],
    authorization: "CRON_SECRET y EXPENSE_OCR_ENABLED; el repositorio opera únicamente RPC de cola fenced.",
    resources: ["RPC de expense_ocr_jobs", "bucket privado expense-receipts READ"],
  },
  "expense-file-scan-worker": {
    consumers: ["src/lib/expense-file-scan/service.ts"],
    entrypoints: ["CRON"],
    authorization: "CRON_SECRET y EXPENSE_FILE_SCAN_ENABLED; RPC reclama solo archivos externos en cuarentena con lease fenced.",
    resources: ["RPC de cuarentena expense_file_scans", "bucket privado expense-receipts READ"],
  },
  "expense-receipt-storage": {
    consumers: ["src/lib/expense-capture/service.ts"],
    entrypoints: ["USER_ACTION", "WEBHOOK"],
    authorization: "La sesión o el webhook se valida antes; cada RPC vuelve a comprobar actor, empresa, permiso y lease.",
    resources: ["bucket privado expense-receipts", "expense_receipt_captures", "RPC de registro y descarte"],
  },
  "expense-email-ingestion": {
    consumers: ["src/lib/expense-email/service.ts"],
    entrypoints: ["WEBHOOK"],
    authorization: "Firma Svix, feature flag, alias opaco, membresía y cuotas antes de persistir.",
    resources: ["RPC de alias, ledger, cuotas y captura de correo"],
  },
  "expense-whatsapp-ingestion": {
    consumers: ["src/lib/expense-whatsapp/service.ts"],
    entrypoints: ["WEBHOOK"],
    authorization: "Firma Meta, feature flag, phone_number_id, vínculo HMAC, membresía y cuotas antes de persistir.",
    resources: ["RPC de pairing, ledger, cuotas y captura de WhatsApp"],
  },
  "expense-bank-import": {
    consumers: ["src/lib/expense-bank/service.ts"],
    entrypoints: ["USER_ACTION", "INTERNAL"],
    authorization: "La acción valida sesión, permiso y archivo; los RPC revalidan actor y empresa.",
    resources: ["RPC de cuota e importación bancaria"],
  },
  "expense-accounting-worker": {
    consumers: ["src/lib/expense-accounting/service.ts"],
    entrypoints: ["CRON"],
    authorization: "CRON_SECRET, feature flag y RPC fenced; no existe acceso directo a las tablas del outbox.",
    resources: ["RPC de scheduler, claim, complete, health y DLQ contable"],
  },
  "expense-assistant-retention": {
    consumers: ["src/lib/expense-assistant/service.ts"],
    entrypoints: ["CRON"],
    authorization: "CRON_SECRET; solo ejecuta la purga global de retención fija.",
    resources: ["purge_expired_expense_assistant_queries()"],
  },
  "supporting-document-cleanup": {
    consumers: ["src/lib/supporting-document-cleanup/service.ts"],
    entrypoints: ["CRON"],
    authorization: "CRON_SECRET y flag fail-closed; RPC entrega solo reservas vencidas, no consumidas y sin documento registrado.",
    resources: ["RPC fenced y snapshot agregado de supporting_document_upload_intents", "bucket privado supporting-documents DELETE"],
  },
  "staging-data-inventory": {
    consumers: ["src/lib/staging-preflight/service.ts"],
    entrypoints: ["OPERATOR_SCRIPT"],
    authorization: "Operador local con .env.staging; solo conteos HEAD sobre una allowlist fija y nunca retorna filas.",
    resources: ["Conteo agregado de tablas públicas clasificadas para sanear staging"],
  },
} as const;

export type ServiceRoleCapability = keyof typeof SERVICE_ROLE_CAPABILITIES;

export function assertServiceRoleCapability(value: string): asserts value is ServiceRoleCapability {
  if (!Object.hasOwn(SERVICE_ROLE_CAPABILITIES, value)) {
    throw new Error("Capacidad service_role no registrada.");
  }
}
