import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import type { Database } from "../supabase/database.types";
import type { ProductionMealDiscountDataset } from "./types";
import { buildProductionMealDiscountDataset, parseProductionMealDiscountRows } from "./source-workbook";

/**
 * Fuente compartida del Excel de descuentos de Colaciones -- reemplaza la
 * lectura del filesystem local (`DESCUENTO DE COLACIONES.xlsx`, gitignored,
 * nunca viajaba con el despliegue) por Supabase Storage privado +
 * `colaciones_discount_workbooks` (exactamente una fila `active` a la vez,
 * ver migración `20260828100000`). Mismo patrón ya usado para el maestro de
 * proveedores -- sin inventar uno nuevo. El parseo/interpretación de negocio
 * sigue siendo `parseProductionMealDiscountRows`/`buildProductionMealDiscountDataset`,
 * sin cambios; lo único que cambia es de dónde vienen los bytes.
 */

const BUCKET = "colaciones-config-files";

interface DiscountWorkbookRow {
  id: string;
  storage_path: string;
  original_filename: string;
  uploaded_at: string;
}

export interface DiscountWorkbookMeta {
  id: string;
  originalFilename: string;
  uploadedAt: string;
}

function toMeta(row: DiscountWorkbookRow): DiscountWorkbookMeta {
  return { id: row.id, originalFilename: row.original_filename, uploadedAt: row.uploaded_at };
}

async function fetchActiveDiscountWorkbookRow(supabase: SupabaseClient<Database>): Promise<DiscountWorkbookRow | null> {
  const { data, error } = await supabase
    .from("colaciones_discount_workbooks")
    .select("id, storage_path, original_filename, uploaded_at")
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`No pudimos leer la configuración del archivo de descuentos: ${error.message}`);
  return data;
}

/** Solo metadata (rápido, sin descargar/parsear) -- usado por la tarjeta de administración aunque el parseo del dataset falle. */
export async function getActiveDiscountWorkbookMeta(supabase: SupabaseClient<Database>): Promise<DiscountWorkbookMeta | null> {
  const row = await fetchActiveDiscountWorkbookRow(supabase);
  return row ? toMeta(row) : null;
}

/**
 * `null` = no hay ningún archivo activo configurado todavía (nunca se
 * inventa un dataset vacío -- el llamador debe mostrar el error
 * administrativo explícito, ver Colaciones page.tsx). Lanza una excepción
 * real si hay un archivo activo pero Storage/el parseo fallan -- nunca
 * "finge" que los datos existen.
 */
export async function getActiveDiscountWorkbookDataset(
  supabase: SupabaseClient<Database>
): Promise<{ dataset: ProductionMealDiscountDataset; meta: DiscountWorkbookMeta } | null> {
  const row = await fetchActiveDiscountWorkbookRow(supabase);
  if (!row) return null;

  const { data: fileBlob, error: downloadError } = await supabase.storage.from(BUCKET).download(row.storage_path);
  if (downloadError || !fileBlob) {
    throw new Error(`No pudimos descargar el archivo de descuentos activo: ${downloadError?.message ?? "sin datos"}`);
  }

  const bytes = new Uint8Array(await fileBlob.arrayBuffer());
  const dataset = buildProductionMealDiscountDataset(bytes, row.original_filename);
  return { dataset, meta: toMeta(row) };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-150);
}

export interface UpdateDiscountWorkbookParams {
  fileBytes: Uint8Array;
  originalFilename: string;
  uploadedBy: string;
}

/**
 * Reemplazo seguro (encargo, sección 4): valida ANTES de tocar nada
 * persistente -- si el Excel no tiene la estructura esperada, no se sube
 * nada a Storage y el archivo activo actual queda intacto. Sube a un objeto
 * NUEVO (nunca sobreescribe el activo) y recién entonces activa
 * atómicamente vía `activate_colaciones_discount_workbook` (una función, una
 * transacción -- si falla, el activo anterior nunca se toca; el objeto ya
 * subido a Storage queda huérfano pero inofensivo, igual que el criterio ya
 * usado para el maestro de proveedores).
 */
export async function updateActiveDiscountWorkbook(
  supabase: SupabaseClient<Database>,
  params: UpdateDiscountWorkbookParams
): Promise<{ id: string }> {
  const workbook = XLSX.read(params.fileBytes, { type: "array", cellDates: true });
  const detailSheet = workbook.Sheets.Hoja1;
  if (!detailSheet) throw new Error("El Excel no contiene la hoja Hoja1 esperada.");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(detailSheet, { header: 1, raw: true, defval: null });
  // Reutiliza el parser existente para validar la estructura -- lanza el mismo error ya conocido si está mal formado. Nunca se persiste nada si esto falla.
  parseProductionMealDiscountRows(rows);

  const id = crypto.randomUUID();
  const storagePath = `${id}/${sanitizeFilename(params.originalFilename)}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, params.fileBytes, {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    upsert: false,
  });
  if (uploadError) throw new Error(`No pudimos subir el archivo a Storage: ${uploadError.message}`);

  // Buffer.from() normaliza cualquier forma de bytes (Uint8Array real, u otro TypedArray/ArrayBuffer-like)
  // -- createHash().update() exige específicamente un Buffer/TypedArray real, no cualquier objeto "array-like".
  const checksum = createHash("sha256").update(Buffer.from(params.fileBytes)).digest("hex");

  const { error: rpcError } = await supabase.rpc("activate_colaciones_discount_workbook", {
    p_id: id,
    p_storage_path: storagePath,
    p_original_filename: params.originalFilename,
    p_file_size: params.fileBytes.byteLength,
    p_checksum: checksum,
    p_uploaded_by: params.uploadedBy,
  });
  if (rpcError) throw new Error(`No pudimos activar el nuevo archivo: ${rpcError.message}`);

  return { id };
}
