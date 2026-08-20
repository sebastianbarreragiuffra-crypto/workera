"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { parseSuppliersExcel, importSuppliers } from "../../../lib/payroll/suppliers-import";
import { parseInvoiceExcel, generatePayrollBatch } from "../../../lib/payroll/invoice-import";

/**
 * Server Actions de Nómina de Pago. Cada una usa el cliente de SESIÓN
 * (nunca admin) -- RLS (`is_privileged_admin()`) sigue siendo el
 * enforcement real; el chequeo de rol acá es una segunda capa con mensaje
 * claro, no la única barrera.
 */

async function requirePayrollAccess() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") {
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
  parseIssues?: number;
}

export async function generatePayrollBatchAction(_prev: GenerateBatchActionState, formData: FormData): Promise<GenerateBatchActionState> {
  const profile = await requirePayrollAccess();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona el Excel mensual de facturas antes de generar la nómina." };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseInvoiceExcel(fileBytes);
  if (parsed.issues.some((i) => i.reason === "HEADER_NOT_FOUND")) {
    return { status: "error", message: "No se encontraron las columnas esperadas (Nro. Docto. / Nombre Cliente / Valor Total ($)) en el archivo." };
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
    unmatchedNames: result.items.filter((i) => i.status === "UNMATCHED").map((i) => i.nombreCliente),
    parseIssues: parsed.issues.length,
  };
}
