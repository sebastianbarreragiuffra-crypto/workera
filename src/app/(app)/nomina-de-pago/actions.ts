"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { parseSuppliersExcel, importSuppliers } from "../../../lib/payroll/suppliers-import";
import { parseInvoiceExcel, generatePayrollBatch } from "../../../lib/payroll/invoice-import";
import { computeSupplierMasterPreview, applySupplierMasterImport, validateFileMeta, type SupplierMasterPreview } from "../../../lib/payroll/supplier-master";

/**
 * Server Actions de Nómina de Pago. Cada una usa el cliente de SESIÓN
 * (nunca admin) -- RLS (`is_privileged_admin()`) sigue siendo el
 * enforcement real; el chequeo de rol acá es una segunda capa con mensaje
 * claro, no la única barrera.
 */

async function requirePayrollAccess() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (!isPrivilegedAdmin(profile.role)) {
    throw new Error("Esta operación requiere rol SUPER_ADMIN o ADMIN_RRHH.");
  }
  return profile;
}

export interface UploadSuppliersActionState {
  status: "idle" | "success" | "conflict" | "error";
  message: string;
  imported?: number;
  updated?: number;
  conflicts?: { normalizedName: string; rows: number[] }[];
  parseIssues?: number;
}

export async function uploadSuppliersAction(_prev: UploadSuppliersActionState, formData: FormData): Promise<UploadSuppliersActionState> {
  const profile = await requirePayrollAccess();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona un archivo antes de importar." };
  }
  const fileMeta = validateFileMeta(file.name, file.size);
  if (!fileMeta.ok) {
    return { status: "error", message: fileMeta.error! };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseSuppliersExcel(fileBytes);
  if (parsed.issues.some((i) => i.reason === "HEADER_NOT_FOUND")) {
    return {
      status: "error",
      message: "No encontramos las columnas Rut / Nombre Beneficiario / FP / BCO / N° Cuenta en ninguna hoja de este archivo. ¿Es el listado de proveedores correcto?",
    };
  }
  if (parsed.valid.length === 0) {
    return { status: "error", message: "No se encontraron filas válidas en el archivo." };
  }

  const result = await importSuppliers(supabase, parsed.valid, profile.id);
  if (result.conflicts.length > 0) {
    return {
      status: "conflict",
      message: "Hay proveedores con el mismo nombre pero datos bancarios distintos dentro del archivo -- no se importó nada.",
      conflicts: result.conflicts,
    };
  }

  revalidatePath("/nomina-de-pago");
  return {
    status: "success",
    message: `Maestro de proveedores actualizado: ${result.imported} nuevos, ${result.updated} actualizados.`,
    imported: result.imported,
    updated: result.updated,
    parseIssues: parsed.issues.length,
  };
}

export interface GenerateBatchActionState {
  status: "idle" | "success" | "error";
  message: string;
  batchId?: string;
  matchedCount?: number;
  unmatchedCount?: number;
  unmatchedNames?: string[];
  totalAmount?: number;
  parseIssues?: number;
}

export async function generatePayrollBatchAction(_prev: GenerateBatchActionState, formData: FormData): Promise<GenerateBatchActionState> {
  const profile = await requirePayrollAccess();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona el Excel mensual de facturas antes de generar la nómina." };
  }
  const meta = validateFileMeta(file.name, file.size);
  if (!meta.ok) {
    return { status: "error", message: meta.error! };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseInvoiceExcel(fileBytes);

  if (parsed.issues.some((i) => i.reason === "AMBIGUOUS_SHEET")) {
    const sheets = parsed.diagnostics?.candidateSheets?.join(", ") ?? "";
    return {
      status: "error",
      message: `El archivo tiene varias hojas que podrían contener las facturas (${sheets}) y no pudimos determinar cuál usar. Deja una sola hoja con los datos de facturas, o renombra/elimina las demás.`,
    };
  }

  if (parsed.issues.some((i) => i.reason === "HEADER_NOT_FOUND")) {
    const d = parsed.diagnostics;
    // Diagnóstico seguro en el log del servidor -- solo nombres de hoja/columna, nunca datos de fila.
    console.info("[nomina-de-pago] parseInvoiceExcel: encabezado no reconocido.", {
      sheetNames: d?.sheetNames,
      columnasDetectadas: d?.detectedHeaders,
      faltantes: d?.missingConcepts,
    });
    const detected = d?.detectedHeaders?.length ? ` Columnas detectadas: ${d.detectedHeaders.join(", ")}.` : "";
    const missing = d?.missingConcepts?.length ? ` Faltan: ${d.missingConcepts.join(", ")}.` : "";
    return {
      status: "error",
      message: `No pudimos identificar la estructura del archivo de facturas.${detected}${missing}`,
    };
  }
  if (parsed.valid.length === 0) {
    return { status: "error", message: "No se encontraron filas válidas en el archivo." };
  }

  const result = await generatePayrollBatch(supabase, parsed.valid, file.name, profile.id);

  revalidatePath("/nomina-de-pago");
  return {
    status: "success",
    message: `Nómina generada: ${result.matchedCount} proveedores con datos bancarios, ${result.unmatchedCount} sin coincidencia.`,
    batchId: result.batchId,
    matchedCount: result.matchedCount,
    unmatchedCount: result.unmatchedCount,
    unmatchedNames: result.items.filter((i) => i.status === "UNMATCHED").map((i) => i.nombreCliente || i.rut || `Factura ${i.nroDocto}`),
    totalAmount: result.totalAmount,
    parseIssues: parsed.issues.length,
  };
}

/**
 * Reemplazo seguro del maestro de proveedores -- módulo independiente
 * dentro de Nómina de Pago, sin relación con el "Importar proveedores"
 * simple de arriba (ese sigue existiendo tal cual). Flujo en dos pasos:
 * preview (solo lectura) -> confirm (vuelve a validar desde los bytes
 * reales del archivo, nunca confía en los conteos que muestre el cliente).
 */

export interface SupplierMasterPreviewActionState {
  status: "idle" | "ready" | "blocked" | "error";
  message: string;
  preview?: SupplierMasterPreview;
}

export async function previewSupplierMasterAction(_prev: SupplierMasterPreviewActionState, formData: FormData): Promise<SupplierMasterPreviewActionState> {
  await requirePayrollAccess();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona un archivo antes de continuar." };
  }

  const meta = validateFileMeta(file.name, file.size);
  if (!meta.ok) {
    return { status: "error", message: meta.error! };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const preview = await computeSupplierMasterPreview(supabase, fileBytes);
  if (!preview.ok) {
    return { status: "blocked", message: preview.blockingError ?? "El archivo no pasó la validación.", preview };
  }

  return { status: "ready", message: "Vista previa calculada.", preview };
}

export interface ConfirmSupplierMasterActionState {
  status: "idle" | "success" | "error";
  message: string;
  insertedCount?: number;
  updatedCount?: number;
  unchangedCount?: number;
}

export async function confirmSupplierMasterAction(_prev: ConfirmSupplierMasterActionState, formData: FormData): Promise<ConfirmSupplierMasterActionState> {
  const profile = await requirePayrollAccess();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona un archivo antes de confirmar." };
  }

  const meta = validateFileMeta(file.name, file.size);
  if (!meta.ok) {
    return { status: "error", message: meta.error! };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());

  try {
    const result = await applySupplierMasterImport(supabase, { fileBytes, filename: file.name, uploadedBy: profile.id });
    revalidatePath("/nomina-de-pago");
    return {
      status: "success",
      message: `Maestro de proveedores actualizado: ${result.insertedCount} nuevos, ${result.updatedCount} actualizados, ${result.unchangedCount} sin cambios.`,
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
      unchangedCount: result.unchangedCount,
    };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos actualizar el maestro de proveedores." };
  }
}
