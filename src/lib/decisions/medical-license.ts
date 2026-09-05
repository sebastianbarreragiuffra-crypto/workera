import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import {
  discardStagedSupportingDocument,
  stageSupportingDocument,
  validateSupportingDocumentFile,
} from "./documents";

/**
 * Flujo de dos etapas para licencias médicas: subir documento -> pendiente
 * de aprobación RRHH -> aprobar (genera "L" en asistencia) o rechazar
 * (nunca genera "L"). `create_pending_medical_license` crea
 * `absence_records`, `supporting_documents` y `medical_license_approvals` en
 * un solo commit después de que el archivo reservado existe en Storage.
 * Aprobar/rechazar conserva los RPC atómicos originales.
 *
 * Subir un documento NUNCA aprueba nada -- la fila nace en
 * `PENDING_RRHH_APPROVAL` y solo la cuenta marcada
 * `profiles.medical_license_approver` puede transicionarla (RLS + las dos
 * funciones lo exigen; `requireMedicalLicenseApprover()` en
 * `authorize.ts` es la segunda capa del lado de Server Actions).
 */

export interface UploadMedicalLicenseInput {
  employeeId: string;
  proposedStartDate: string;
  proposedEndDate: string;
  extractionStatus: "EXTRAIDO" | "REQUIERE_REVISION";
  originalFilename: string;
  mimeType: string;
  fileBytes: Uint8Array;
}

export interface UploadMedicalLicenseResult {
  approvalId: string;
  absenceRecordId: string;
  documentId: string;
}

/**
 * Reserva/sube el archivo y confirma el grafo de licencia en una transacción.
 * El RPC deriva el actor de auth.uid(), repite `can_manage_employee` y es la
 * autoridad real; ningún estado/actor llega desde el cliente.
 */
export async function uploadMedicalLicense(
  supabase: SupabaseClient<Database>,
  input: UploadMedicalLicenseInput
): Promise<UploadMedicalLicenseResult> {
  // Fallar por contenido/tamaño no crea ni siquiera una reserva.
  validateSupportingDocumentFile(input.fileBytes, input.mimeType);
  const staged = await stageSupportingDocument(supabase, input);
  try {
    const { data, error } = await supabase.rpc("create_pending_medical_license", {
      p_intent_id: staged.intentId,
      p_original_filename: input.originalFilename.slice(-240),
      p_proposed_start_date: input.proposedStartDate,
      p_proposed_end_date: input.proposedEndDate,
      p_extraction_status: input.extractionStatus,
    }).single();
    if (error || !data) {
      throw new Error(`No se pudo crear la licencia pendiente: ${error?.message ?? "sin respuesta"}`);
    }
    return {
      approvalId: data.approval_id,
      absenceRecordId: data.absence_record_id,
      documentId: data.document_id,
    };
  } catch (error) {
    // El RPC revierte sus tres inserts como una sola transacción; solo queda
    // compensar el objeto de Storage que necesariamente se cargó antes.
    await discardStagedSupportingDocument(supabase, staged);
    throw error;
  }
}

export interface LicenseSummary {
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  /** APPROVED cuyo rango CONFIRMADO incluye la fecha dada -- "licencia activa" = alguien con licencia hoy, distinto de "aprobada alguna vez". */
  activeNowCount: number;
  hasAnyLicense: boolean;
}

/**
 * Resumen para la tarjeta "Licencias activas" -- puramente derivado de la
 * lista ya cargada (`listMedicalLicenses`), sin consultas nuevas. Nunca
 * cuenta pendientes/rechazadas como "activas" (rule: solo lo aprobado
 * genera efecto real).
 */
export function computeLicenseSummary(licenses: MedicalLicenseListItem[], todayISO: string): LicenseSummary {
  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;
  let activeNowCount = 0;

  for (const license of licenses) {
    if (license.status === "PENDING_RRHH_APPROVAL") pendingCount += 1;
    else if (license.status === "REJECTED") rejectedCount += 1;
    else if (license.status === "APPROVED") {
      approvedCount += 1;
      if (license.confirmedStartDate && license.confirmedEndDate && todayISO >= license.confirmedStartDate && todayISO <= license.confirmedEndDate) {
        activeNowCount += 1;
      }
    }
  }

  return { pendingCount, approvedCount, rejectedCount, activeNowCount, hasAnyLicense: licenses.length > 0 };
}

export interface MedicalLicenseListItem {
  approvalId: string;
  status: "PENDING_RRHH_APPROVAL" | "APPROVED" | "REJECTED";
  employeeId: string;
  employeeName: string;
  areaCode: string | null;
  proposedStartDate: string;
  proposedEndDate: string;
  /** Resultado de la extracción automática asistida (ver medical-license-extraction.ts). Null = licencia subida antes de esta fase. */
  extractionStatus: "EXTRAIDO" | "REQUIERE_REVISION" | null;
  confirmedStartDate: string | null;
  confirmedEndDate: string | null;
  uploadedByName: string;
  uploadedAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectedByName: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  documentId: string;
}

interface MedicalLicenseRow {
  id: string;
  status: "PENDING_RRHH_APPROVAL" | "APPROVED" | "REJECTED";
  proposed_start_date: string;
  proposed_end_date: string;
  extraction_status: "EXTRAIDO" | "REQUIERE_REVISION" | null;
  confirmed_start_date: string | null;
  confirmed_end_date: string | null;
  uploaded_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  supporting_document_id: string;
  absence_records:
    | { employee_id: string; employees: EmployeeRel }
    | { employee_id: string; employees: EmployeeRel }[]
    | null;
  uploader: { display_name: string } | { display_name: string }[] | null;
  approver: { display_name: string } | { display_name: string }[] | null;
  rejecter: { display_name: string } | { display_name: string }[] | null;
}

type EmployeeRel =
  | { display_name: string; employee_groups: { code: string } | { code: string }[] | null }
  | { display_name: string; employee_groups: { code: string } | { code: string }[] | null }[]
  | null;

function single<T>(rel: T | T[] | null): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

function mapRow(row: MedicalLicenseRow): MedicalLicenseListItem {
  const absence = single(row.absence_records);
  const employee = absence ? single(absence.employees) : null;
  const employeeGroup = employee ? single(employee.employee_groups) : null;
  return {
    approvalId: row.id,
    status: row.status,
    employeeId: absence?.employee_id ?? "",
    employeeName: employee?.display_name ?? "—",
    areaCode: employeeGroup?.code ?? null,
    proposedStartDate: row.proposed_start_date,
    proposedEndDate: row.proposed_end_date,
    extractionStatus: row.extraction_status,
    confirmedStartDate: row.confirmed_start_date,
    confirmedEndDate: row.confirmed_end_date,
    uploadedByName: single(row.uploader)?.display_name ?? "—",
    uploadedAt: row.uploaded_at,
    approvedByName: single(row.approver)?.display_name ?? null,
    approvedAt: row.approved_at,
    rejectedByName: single(row.rejecter)?.display_name ?? null,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    documentId: row.supporting_document_id,
  };
}

const SELECT_COLUMNS =
  "id, status, proposed_start_date, proposed_end_date, extraction_status, confirmed_start_date, confirmed_end_date, uploaded_at, approved_at, rejected_at, rejection_reason, supporting_document_id, " +
  "absence_records!inner(employee_id, employees(display_name, employee_groups!employees_company_group_fkey(code))), " +
  "uploader:uploaded_by(display_name), approver:approved_by(display_name), rejecter:rejected_by(display_name)";

/**
 * Lista licencias visibles para el llamador -- el scoping real lo aplica
 * RLS (`medical_license_approvals_select`): el aprobador y is_privileged_admin
 * ven todo, cualquier otro usuario solo ve las de empleados que puede
 * gestionar. No hay chequeo adicional de área acá porque no hace falta
 * duplicar lo que RLS ya garantiza a nivel de fila.
 */
export async function listMedicalLicenses(
  supabase: SupabaseClient<Database>,
  filter?: { onlyPending?: boolean }
): Promise<MedicalLicenseListItem[]> {
  let query = supabase.from("medical_license_approvals").select(SELECT_COLUMNS).order("uploaded_at", { ascending: false });
  if (filter?.onlyPending) query = query.eq("status", "PENDING_RRHH_APPROVAL");

  const { data, error } = await query;
  if (error) throw new Error(`listMedicalLicenses: fallo listando licencias: ${error.message}`);
  return ((data ?? []) as unknown as MedicalLicenseRow[]).map(mapRow);
}

/**
 * Debe coincidir con la cota de `approve_medical_license`
 * (20260903100000_medical_license_range_bound.sql). Esa función escribe una
 * fila de asistencia POR DÍA del rango, así que el límite real vive en la base;
 * acá se repite solo para poder rechazar antes y con un mensaje claro.
 */
export const MAX_MEDICAL_LICENSE_DAYS = 366;

export interface ApproveMedicalLicenseInput {
  approvalId: string;
  confirmedStartDate: string;
  confirmedEndDate: string;
}

/** Llama a la función atómica -- ver comentario en la migración sobre por qué es una función de base de datos y no varios pasos desde la app. */
export async function approveMedicalLicense(supabase: SupabaseClient<Database>, input: ApproveMedicalLicenseInput): Promise<void> {
  const { error } = await supabase.rpc("approve_medical_license", {
    p_approval_id: input.approvalId,
    p_confirmed_start_date: input.confirmedStartDate,
    p_confirmed_end_date: input.confirmedEndDate,
  });
  if (error) throw new Error(`approveMedicalLicense: ${error.message}`);
}

export interface RejectMedicalLicenseInput {
  approvalId: string;
  reason: string;
}

export async function rejectMedicalLicense(supabase: SupabaseClient<Database>, input: RejectMedicalLicenseInput): Promise<void> {
  const { error } = await supabase.rpc("reject_medical_license", {
    p_approval_id: input.approvalId,
    p_reason: input.reason,
  });
  if (error) throw new Error(`rejectMedicalLicense: ${error.message}`);
}
