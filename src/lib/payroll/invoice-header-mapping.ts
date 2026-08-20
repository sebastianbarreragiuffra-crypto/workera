/**
 * Mapeo centralizado de encabezados del Excel mensual de facturas que envía
 * Finanzas (ARCOTEX). El archivo real NO usa siempre el mismo texto literal
 * de columna mes a mes -- distintas plantillas de Finanzas usan variantes
 * como "N° Documento" / "Nº Documento" / "Numero Documento" / "Folio" para
 * el mismo concepto. Esta capa normaliza cada celda de encabezado y la
 * compara contra listas explícitas de alias por concepto -- nunca acepta
 * cualquier texto ambiguo, solo los alias enumerados acá.
 *
 * Comparación SIEMPRE por igualdad exacta de texto normalizado (nunca
 * `includes`/substring) para no generar falsos positivos entre conceptos
 * parecidos (ej. "Documento" vs "Total Documento" son conceptos distintos).
 */

export type InvoiceHeaderConcept = "DOCUMENTO" | "PROVEEDOR_NOMBRE" | "PROVEEDOR_RUT" | "MONTO";

/** minúsculas, sin acentos, sin puntuación/símbolos ("°", "º", "$", ".", saltos de línea), espacios colapsados. */
export function normalizeHeaderCell(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const DOCUMENT_ALIASES = new Set(["nro docto", "nro doc", "n documento", "no documento", "numero documento", "nro documento", "documento", "folio", "n doc", "n folio"]);

const SUPPLIER_NAME_ALIASES = new Set(["nombre cliente", "nombre proveedor", "proveedor", "razon social", "nombre beneficiario"]);

const SUPPLIER_RUT_ALIASES = new Set(["rut proveedor", "rut cliente", "rut beneficiario", "rut"]);

const AMOUNT_ALIASES = new Set(["valor total", "total", "monto total", "monto", "total documento", "valor documento"]);

export function matchInvoiceHeaderConcept(rawCell: unknown): InvoiceHeaderConcept | null {
  const normalized = normalizeHeaderCell(rawCell);
  if (!normalized) return null;
  if (DOCUMENT_ALIASES.has(normalized)) return "DOCUMENTO";
  if (SUPPLIER_RUT_ALIASES.has(normalized)) return "PROVEEDOR_RUT";
  if (SUPPLIER_NAME_ALIASES.has(normalized)) return "PROVEEDOR_NOMBRE";
  if (AMOUNT_ALIASES.has(normalized)) return "MONTO";
  return null;
}

const CONCEPT_LABELS: Record<InvoiceHeaderConcept, string> = {
  DOCUMENTO: "Número/Folio de documento",
  PROVEEDOR_NOMBRE: "Nombre de proveedor",
  PROVEEDOR_RUT: "RUT de proveedor",
  MONTO: "Monto total",
};

/** Etiquetas legibles de los conceptos que faltan, para el mensaje de error. RUT y Nombre cuentan como UN solo requisito ("identificador de proveedor"), ya que basta con cualquiera de los dos. */
export function describeMissingConcepts(found: InvoiceHeaderConcept[]): string[] {
  const missing: string[] = [];
  if (!found.includes("DOCUMENTO")) missing.push(CONCEPT_LABELS.DOCUMENTO);
  if (!found.includes("MONTO")) missing.push(CONCEPT_LABELS.MONTO);
  if (!found.includes("PROVEEDOR_RUT") && !found.includes("PROVEEDOR_NOMBRE")) missing.push("RUT o nombre de proveedor");
  return missing;
}
