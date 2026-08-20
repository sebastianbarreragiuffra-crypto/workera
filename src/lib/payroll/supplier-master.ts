import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { parseSuppliersExcel, type ParsedSupplierRow, type SupplierParseIssue } from "./suppliers-import";
import { normalizeName as normalizeNameLocal, normalizeRut } from "../business-rules/name-matching";

/**
 * Reemplazo seguro del maestro de proveedores (Nómina de Pago -- módulo
 * independiente, sin ninguna relación con Workera/asistencia/sync).
 *
 * Identificador canónico: RUT normalizado (`normalizeRut`), nunca el
 * nombre -- dos proveedores nunca deben tratarse como el mismo solo porque
 * el nombre se parece ("Proveedor ABC SpA" != "Proveedor ABC Ltda." salvo
 * que el RUT normalizado coincida). El cruce con el Excel MENSUAL de
 * facturas (`invoice-import.ts`) sigue siendo por nombre porque ese
 * archivo de finanzas no trae RUT -- esto no cambia esa lógica existente,
 * solo agrega el reemplazo seguro del maestro en sí.
 */

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB -- límite explícito documentado, no arbitrario silencioso.
const MAX_ROWS = 5000;
const ALLOWED_EXTENSIONS = [".xlsx", ".xls", ".csv"];

export interface FileMetaValidation {
  ok: boolean;
  error?: string;
}

/** Valida SOLO por extensión real del nombre de archivo -- nunca confía en el MIME type reportado por el navegador (fácil de falsificar). */
export function validateFileMeta(filename: string, sizeBytes: number): FileMetaValidation {
  const lower = filename.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, error: `Formato no soportado. Usa uno de: ${ALLOWED_EXTENSIONS.join(", ")}.` };
  }
  if (sizeBytes <= 0) {
    return { ok: false, error: "El archivo está vacío." };
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: `El archivo supera el máximo permitido (${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB).` };
  }
  return { ok: true };
}

export type SupplierMasterRowStatus = "NEW" | "UPDATED" | "UNCHANGED";

export interface SupplierMasterPreviewRow {
  rowNumber: number;
  normalizedRut: string;
  name: string;
  status: SupplierMasterRowStatus;
}

export interface SupplierMasterPreviewError {
  rowNumber: number;
  supplierName: string | null;
  problem: string;
}

export interface SupplierMasterPreview {
  ok: boolean;
  /** Si es false, ningún dato del maestro se debe persistir -- ver `blockingError`. */
  blockingError: string | null;
  totalFound: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorCount: number;
  errors: SupplierMasterPreviewError[];
  rows: SupplierMasterPreviewRow[];
  /** Filas ya deduplicadas y listas para persistir si el usuario confirma -- nunca se recalculan a partir de lo que mande el cliente en el paso de confirmación. */
  validRows: ParsedSupplierRow[];
}

function issueLabel(reason: SupplierParseIssue["reason"]): string {
  switch (reason) {
    case "MISSING_FIELD":
      return "Faltan campos obligatorios (Rut/Nombre/FP/BCO/N° Cuenta) en esta fila.";
    case "HEADER_NOT_FOUND":
      return "No se encontraron las columnas esperadas (Rut, Nombre Beneficiario, FP, BCO, N° Cuenta) en ninguna hoja del archivo.";
  }
}

/**
 * Valida y calcula la vista previa -- SOLO LECTURA, nunca persiste nada.
 * Debe volver a ejecutarse íntegramente en el paso de confirmación (nunca
 * confiar en los conteos que el cliente devuelva de este paso).
 */
export async function computeSupplierMasterPreview(supabase: SupabaseClient<Database>, fileBytes: Uint8Array): Promise<SupplierMasterPreview> {
  let parsed: ReturnType<typeof parseSuppliersExcel>;
  try {
    parsed = parseSuppliersExcel(fileBytes);
  } catch {
    return {
      ok: false,
      blockingError: "No pudimos leer el archivo. Verifica que no esté dañado y que sea un Excel/CSV válido.",
      totalFound: 0,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      errorCount: 0,
      errors: [],
      rows: [],
      validRows: [],
    };
  }

  if (parsed.issues.some((i) => i.reason === "HEADER_NOT_FOUND")) {
    return {
      ok: false,
      blockingError: issueLabel("HEADER_NOT_FOUND"),
      totalFound: 0,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      errorCount: 0,
      errors: [],
      rows: [],
      validRows: [],
    };
  }

  if (parsed.valid.length > MAX_ROWS) {
    return {
      ok: false,
      blockingError: `El archivo tiene ${parsed.valid.length} filas, más que el máximo permitido (${MAX_ROWS}).`,
      totalFound: parsed.valid.length,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      errorCount: 0,
      errors: [],
      rows: [],
      validRows: [],
    };
  }

  const errors: SupplierMasterPreviewError[] = parsed.issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    supplierName: null,
    problem: issueLabel(issue.reason),
  }));

  // Duplicados de RUT DENTRO del mismo archivo: si los datos bancarios difieren, es un conflicto real
  // (nunca se elige uno en silencio); si son idénticos, es una fila repetida inofensiva (se deduplica).
  const byRut = new Map<string, ParsedSupplierRow[]>();
  for (const row of parsed.valid) {
    const key = normalizeRut(row.rut);
    if (!byRut.has(key)) byRut.set(key, []);
    byRut.get(key)!.push(row);
  }
  for (const [normalizedRut, group] of byRut) {
    if (group.length <= 1) continue;
    const distinct = new Set(group.map((r) => `${r.name}|${r.paymentMethod}|${r.bankCode}|${r.accountNumber}`));
    if (distinct.size > 1) {
      return {
        ok: false,
        blockingError: `El RUT ${normalizedRut} aparece más de una vez en el archivo con datos distintos (filas ${group.map((r) => r.rowNumber).join(", ")}). Corrige el archivo antes de continuar.`,
        totalFound: parsed.valid.length,
        newCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        errorCount: errors.length,
        errors,
        rows: [],
        validRows: [],
      };
    }
  }
  const dedupedRows = [...byRut.values()].map((group) => group[0]);

  const { data: currentSuppliers, error: currentError } = await supabase
    .from("suppliers")
    .select("normalized_rut, name, payment_method, bank_code, account_number")
    .eq("active", true);
  if (currentError) throw new Error(`computeSupplierMasterPreview: fallo leyendo maestro actual: ${currentError.message}`);

  const currentByRut = new Map((currentSuppliers ?? []).map((s) => [s.normalized_rut, s]));

  const rows: SupplierMasterPreviewRow[] = dedupedRows.map((row) => {
    const normalizedRut = normalizeRut(row.rut);
    const existing = currentByRut.get(normalizedRut);
    let status: SupplierMasterRowStatus;
    if (!existing) status = "NEW";
    else if (existing.name !== row.name || existing.payment_method !== row.paymentMethod || existing.bank_code !== row.bankCode || existing.account_number !== row.accountNumber) status = "UPDATED";
    else status = "UNCHANGED";
    return { rowNumber: row.rowNumber, normalizedRut, name: row.name, status };
  });

  return {
    ok: true,
    blockingError: null,
    totalFound: dedupedRows.length,
    newCount: rows.filter((r) => r.status === "NEW").length,
    updatedCount: rows.filter((r) => r.status === "UPDATED").length,
    unchangedCount: rows.filter((r) => r.status === "UNCHANGED").length,
    errorCount: errors.length,
    errors,
    rows,
    validRows: dedupedRows,
  };
}

export interface ApplySupplierMasterImportParams {
  fileBytes: Uint8Array;
  filename: string;
  uploadedBy: string;
}

export interface ApplySupplierMasterImportResult {
  importId: string;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorCount: number;
}

/**
 * Secuencia segura de reemplazo (PASO 10 del encargo):
 *   1. Vuelve a validar/parsear desde los bytes reales (nunca confía en conteos del cliente).
 *   2. Sube el archivo a un objeto NUEVO en Storage (nunca sobreescribe el activo). Si falla,
 *      no se toca absolutamente nada más.
 *   3. TODO lo demás -- registrar el import, insertar/actualizar `suppliers`, activar el
 *      nuevo y reemplazar el anterior -- ocurre en UNA sola función de base de datos
 *      (`apply_supplier_master_import`, transacción implícita real, no una secuencia de
 *      llamadas desde la app). Si cualquier paso interno falla, TODO se revierte -- nunca
 *      queda `suppliers` mutado con datos del archivo nuevo mientras el import "activo"
 *      registrado sigue siendo el viejo (bug real encontrado al verificar con datos reales:
 *      con pasos separados, una falla justo antes de activar dejaba los proveedores ya
 *      sobreescritos aunque el maestro anterior seguía figurando como el vigente).
 */
export async function applySupplierMasterImport(supabase: SupabaseClient<Database>, params: ApplySupplierMasterImportParams): Promise<ApplySupplierMasterImportResult> {
  const preview = await computeSupplierMasterPreview(supabase, params.fileBytes);
  if (!preview.ok) {
    throw new Error(preview.blockingError ?? "El archivo no pasó la validación.");
  }

  const importId = crypto.randomUUID();
  const storagePath = `${importId}/${sanitizeFilename(params.filename)}`;

  const { error: uploadError } = await supabase.storage.from("supplier-master-files").upload(storagePath, params.fileBytes, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (uploadError) {
    throw new Error(`applySupplierMasterImport: fallo subiendo el archivo a Storage: ${uploadError.message}`);
  }

  // `normalized_rut` solo es único de forma PARCIAL (where active) -- Postgres no puede
  // usar eso como destino de ON CONFLICT. Se resuelve del lado de la app cuál RUT ya
  // tiene un proveedor activo (-> update por `id`, la PK real) y cuál no (-> insert),
  // y se omiten las filas UNCHANGED (nunca se re-escriben sin necesidad); la función de
  // base de datos solo ejecuta los INSERT/UPDATE ya resueltos, dentro de su transacción.
  const { data: currentActiveIds, error: currentActiveIdsError } = await supabase.from("suppliers").select("id, normalized_rut").eq("active", true);
  if (currentActiveIdsError) throw new Error(`applySupplierMasterImport: fallo leyendo el maestro actual para persistir: ${currentActiveIdsError.message}`);
  const idByRut = new Map((currentActiveIds ?? []).map((s) => [s.normalized_rut, s.id]));
  const statusByRowNumber = new Map(preview.rows.map((r) => [r.rowNumber, r.status]));

  const insertRows: Record<string, string>[] = [];
  const updateRows: Record<string, string>[] = [];
  for (const row of preview.validRows) {
    if (statusByRowNumber.get(row.rowNumber) === "UNCHANGED") continue;
    const normalizedRut = normalizeRut(row.rut);
    const base = {
      rut: row.rut,
      name: row.name,
      normalized_name: normalizeNameLocal(row.name),
      normalized_rut: normalizedRut,
      payment_method: row.paymentMethod,
      bank_code: row.bankCode,
      account_number: row.accountNumber,
    };
    const existingId = idByRut.get(normalizedRut);
    if (existingId) updateRows.push({ id: existingId, ...base });
    else insertRows.push(base);
  }

  const { error: applyError } = await supabase.rpc("apply_supplier_master_import", {
    p_import_id: importId,
    p_uploaded_by: params.uploadedBy,
    p_original_filename: params.filename,
    p_storage_path: storagePath,
    p_file_size: params.fileBytes.byteLength,
    p_row_count: preview.totalFound,
    p_inserted_count: preview.newCount,
    p_updated_count: preview.updatedCount,
    p_unchanged_count: preview.unchangedCount,
    p_rejected_count: preview.errorCount,
    p_insert_rows: insertRows,
    p_update_rows: updateRows,
  });
  if (applyError) {
    throw new Error(`applySupplierMasterImport: fallo aplicando el nuevo maestro (nada se guardó, el anterior sigue vigente): ${applyError.message}`);
  }

  return { importId, insertedCount: preview.newCount, updatedCount: preview.updatedCount, unchangedCount: preview.unchangedCount, errorCount: preview.errorCount };
}

export interface ActiveSupplierMasterInfo {
  importId: string;
  filename: string;
  uploadedAt: string;
  uploadedByName: string;
  activeSupplierCount: number;
}

export async function getActiveSupplierMaster(supabase: SupabaseClient<Database>): Promise<ActiveSupplierMasterInfo | null> {
  const [{ data: active, error: activeError }, { count, error: countError }] = await Promise.all([
    supabase.from("supplier_master_imports").select("id, original_filename, uploaded_at, profiles(display_name)").eq("status", "ACTIVE").maybeSingle(),
    supabase.from("suppliers").select("id", { count: "exact", head: true }).eq("active", true),
  ]);
  if (activeError) throw new Error(`getActiveSupplierMaster: fallo leyendo el maestro activo: ${activeError.message}`);
  if (countError) throw new Error(`getActiveSupplierMaster: fallo contando proveedores activos: ${countError.message}`);
  if (!active) return null;

  const profileRelation = active.profiles as { display_name: string } | { display_name: string }[] | null;
  const uploadedByName = (Array.isArray(profileRelation) ? profileRelation[0]?.display_name : profileRelation?.display_name) ?? "—";

  return {
    importId: active.id,
    filename: active.original_filename,
    uploadedAt: active.uploaded_at,
    uploadedByName,
    activeSupplierCount: count ?? 0,
  };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-150);
}
