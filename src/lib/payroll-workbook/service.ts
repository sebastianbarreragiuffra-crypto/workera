import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "../supabase/admin-client";

const PAYROLL_WORKBOOK_BUCKET = "payroll-workbooks";
const MAX_PAYROLL_WORKBOOK_BYTES = 15 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface StoredWorkbookBlob {
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface TrustedPayrollWorkbookClient {
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{
        data: StoredWorkbookBlob | null;
        error: { message: string } | null;
      }>;
      remove(paths: string[]): Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
    };
  };
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
}

type TrustedPayrollWorkbookRpcResult = Awaited<ReturnType<TrustedPayrollWorkbookClient["rpc"]>>;

interface StoredWorkbookIdentity {
  objectId: string;
  version: string | null;
  updatedAt: string;
}

async function runIdempotentRpcWithTransportRetry(
  call: () => Promise<TrustedPayrollWorkbookRpcResult>,
): Promise<TrustedPayrollWorkbookRpcResult> {
  let first: TrustedPayrollWorkbookRpcResult;
  try {
    first = await call();
  } catch {
    return call();
  }
  // postgrest-js captura fallos de fetch y los devuelve con code="". Los
  // errores SQL/PostgREST definitivos sí traen código y no se reintentan.
  if (first.error && !first.error.code?.trim()) return call();
  return first;
}

export interface AcceptTrustedPayrollWorkbookInput {
  actorId: string;
  companyId: string;
  windowType: "DIARIO" | "SEMANAL" | "QUINCENAL" | "MENSUAL";
  periodStart: string;
  periodEnd: string;
  expectedBaseVersionId: string | null;
  expectedSourceRevision: number;
  contentSha256: string;
  fileSize: number;
  storagePath: string;
  generalReason: string;
  changes: readonly unknown[];
}

export interface AcceptTrustedPayrollWorkbookResult {
  versionId: string;
  contentSha256: string;
  fileSize: number;
  idempotencyKey: string;
}

export interface DownloadTrustedPayrollWorkbookInput {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  storagePath: string;
  contentSha256: string;
  fileSize: number;
}

export interface AcceptTrustedPayrollWorkbookDependencies {
  createTrustedClient(): TrustedPayrollWorkbookClient;
}

const DEFAULT_DEPENDENCIES: AcceptTrustedPayrollWorkbookDependencies = {
  createTrustedClient: () => createAdminClient("payroll-workbook-acceptance") as unknown as TrustedPayrollWorkbookClient,
};

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("La solicitud de aceptación contiene un número inválido.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("La solicitud de aceptación contiene un valor no serializable.");
}

function validateInput(input: AcceptTrustedPayrollWorkbookInput): void {
  if (!UUID_PATTERN.test(input.actorId) || !UUID_PATTERN.test(input.companyId)) {
    throw new Error("Actor o empresa inválidos para aceptar la pre-nómina.");
  }
  if (!DATE_PATTERN.test(input.periodStart) || !DATE_PATTERN.test(input.periodEnd)) {
    throw new Error("El período de la pre-nómina no es válido.");
  }
  if (!["DIARIO", "SEMANAL", "QUINCENAL", "MENSUAL"].includes(input.windowType)) {
    throw new Error("La frecuencia de la pre-nómina no es válida.");
  }
  if (input.expectedBaseVersionId !== null && !UUID_PATTERN.test(input.expectedBaseVersionId)) {
    throw new Error("La versión base de la pre-nómina no es válida.");
  }
  if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0) {
    throw new Error("La revisión de fuentes no es válida.");
  }
  if (!SHA256_PATTERN.test(input.contentSha256)
      || !Number.isSafeInteger(input.fileSize)
      || input.fileSize < 1
      || input.fileSize > MAX_PAYROLL_WORKBOOK_BYTES) {
    throw new Error("La evidencia declarada del XLSX no es válida.");
  }
  if (!input.storagePath
      || !input.storagePath.startsWith(`${input.companyId}/${input.periodStart}_${input.periodEnd}/`)
      || !input.storagePath.endsWith(".xlsx")) {
    throw new Error("La ruta privada del XLSX no corresponde a empresa y período.");
  }
  const reasonLength = input.generalReason.trim().length;
  if (reasonLength < 1 || reasonLength > 2_000 || !Array.isArray(input.changes) || input.changes.length > 500) {
    throw new Error("La justificación o la lista de cambios no es válida.");
  }
}

function validateStoredWorkbookPath(input: {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  storagePath: string;
}): void {
  if (!UUID_PATTERN.test(input.companyId)
      || !DATE_PATTERN.test(input.periodStart)
      || !DATE_PATTERN.test(input.periodEnd)
      || !input.storagePath.startsWith(`${input.companyId}/${input.periodStart}_${input.periodEnd}/`)
      || !input.storagePath.endsWith(".xlsx")) {
    throw new Error("La ruta privada del XLSX no corresponde a empresa y período.");
  }
}

function validateDownloadInput(input: DownloadTrustedPayrollWorkbookInput): void {
  validateStoredWorkbookPath(input);
  if (
    !SHA256_PATTERN.test(input.contentSha256)
    || !Number.isSafeInteger(input.fileSize)
    || input.fileSize < 1
    || input.fileSize > MAX_PAYROLL_WORKBOOK_BYTES
  ) {
    throw new Error("La evidencia declarada del XLSX guardado no es válida.");
  }
}

function parseStoredWorkbookIdentity(value: unknown): StoredWorkbookIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Storage no devolvió una identidad verificable para el XLSX.");
  }
  const row = value as Record<string, unknown>;
  if (!UUID_PATTERN.test(String(row.objectId ?? ""))
      || !(row.version === null || typeof row.version === "string")
      || typeof row.updatedAt !== "string"
      || !Number.isFinite(Date.parse(row.updatedAt))) {
    throw new Error("Storage devolvió una identidad inválida para el XLSX.");
  }
  return {
    objectId: String(row.objectId),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

async function readStoredWorkbookIdentity(
  trusted: TrustedPayrollWorkbookClient,
  input: AcceptTrustedPayrollWorkbookInput,
): Promise<StoredWorkbookIdentity> {
  const result = await trusted.rpc("get_payroll_workbook_object_identity", {
    p_company_id: input.companyId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_storage_path: input.storagePath,
  });
  if (result.error) {
    throw new Error("No pudimos fijar la identidad del XLSX privado.");
  }
  return parseStoredWorkbookIdentity(result.data);
}

function sameStoredWorkbookIdentity(
  left: StoredWorkbookIdentity,
  right: StoredWorkbookIdentity,
): boolean {
  return left.objectId === right.objectId
    && left.version === right.version
    && left.updatedAt === right.updatedAt;
}

function acceptanceIdempotencyKey(input: AcceptTrustedPayrollWorkbookInput): string {
  // La ruta se excluye deliberadamente: una repetición HTTP puede volver a
  // subir los mismos bytes bajo otro UUID. El contenido y toda la decisión
  // empresarial sí quedan ligados a la huella.
  const command: Record<string, unknown> = {
    actorId: input.actorId,
    changes: input.changes,
    companyId: input.companyId,
    contentSha256: input.contentSha256,
    expectedBaseVersionId: input.expectedBaseVersionId,
    expectedSourceRevision: input.expectedSourceRevision,
    fileSize: input.fileSize,
    generalReason: input.generalReason.trim(),
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    schemaVersion: "GESTORA_PRENOMINA_2026_V2",
  };
  // Se conserva la huella histórica del mensual. Las versiones de trabajo
  // agregan su frecuencia para que dos ámbitos distintos nunca compartan un
  // recibo idempotente por accidente.
  if (input.windowType !== "MENSUAL") command.windowType = input.windowType;
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

/**
 * Frontera privilegiada de aceptación del XLSX.
 *
 * Debe invocarse solo después de que la ruta autenticada haya validado la
 * sesión ADMIN_RRHH+MFA, el parser, la vista previa firmada y las resoluciones
 * de conflicto. Esta función no confía en el hash ni el tamaño recibidos:
 * descarga el objeto privado y los recalcula antes del único RPC con permiso
 * para confirmar. Ante una respuesta de red ambigua, repite exactamente el
 * mismo comando; el recibo transaccional del RPC lo vuelve idempotente.
 */
export async function acceptTrustedPayrollWorkbook(
  input: AcceptTrustedPayrollWorkbookInput,
  dependencies: AcceptTrustedPayrollWorkbookDependencies = DEFAULT_DEPENDENCIES,
): Promise<AcceptTrustedPayrollWorkbookResult> {
  validateInput(input);
  const idempotencyKey = acceptanceIdempotencyKey(input);
  const trusted = dependencies.createTrustedClient();
  const identityBeforeDownload = await readStoredWorkbookIdentity(trusted, input);
  const downloaded = await trusted.storage.from(PAYROLL_WORKBOOK_BUCKET).download(input.storagePath);
  if (downloaded.error || !downloaded.data) {
    throw new Error("No pudimos verificar el XLSX guardado antes de aceptarlo.");
  }
  if (typeof downloaded.data.size === "number"
      && (downloaded.data.size < 1 || downloaded.data.size > MAX_PAYROLL_WORKBOOK_BYTES)) {
    throw new Error("El XLSX guardado excede el límite permitido.");
  }

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const identityAfterDownload = await readStoredWorkbookIdentity(trusted, input);
  if (!sameStoredWorkbookIdentity(identityBeforeDownload, identityAfterDownload)) {
    throw new Error("El objeto XLSX cambió mientras se verificaban sus bytes.");
  }
  const actualContentSha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  if (bytes.byteLength !== input.fileSize || actualContentSha256 !== input.contentSha256) {
    throw new Error("Los bytes guardados no coinciden con la evidencia revisada.");
  }

  const rpcArgs: Record<string, unknown> = {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_expected_base_version_id: input.expectedBaseVersionId,
    p_content_sha256: input.contentSha256,
    p_file_size: input.fileSize,
    p_storage_path: input.storagePath,
    p_general_reason: input.generalReason.trim(),
    p_changes: input.changes,
    p_expected_source_revision: input.expectedSourceRevision,
    p_verified_content_sha256: actualContentSha256,
    p_verified_file_size: bytes.byteLength,
    p_idempotency_key: idempotencyKey,
    p_storage_object_id: identityAfterDownload.objectId,
    p_storage_object_version: identityAfterDownload.version,
    p_storage_object_updated_at: identityAfterDownload.updatedAt,
  };
  if (input.windowType !== "MENSUAL") rpcArgs.p_window_type = input.windowType;

  const rpc = input.windowType === "MENSUAL"
    ? "register_accepted_payroll_workbook"
    : "register_accepted_working_workbook";
  const committed = await runIdempotentRpcWithTransportRetry(
    () => trusted.rpc(rpc, rpcArgs),
  );
  if (committed.error || typeof committed.data !== "string" || !UUID_PATTERN.test(committed.data)) {
    const error = new Error("No pudimos confirmar la aceptación confiable del XLSX.");
    Object.assign(error, { code: committed.error?.code });
    throw error;
  }

  return {
    versionId: committed.data,
    contentSha256: actualContentSha256,
    fileSize: bytes.byteLength,
    idempotencyKey,
  };
}

/**
 * Única frontera de descarga para libros ya registrados. Las rutas validan
 * sesión, tenant, rol y propósito antes de llamarla; aquí se usa Storage con
 * service_role y se vuelven a cotejar tamaño y SHA-256 de los bytes reales.
 */
export async function downloadTrustedPayrollWorkbook(
  input: DownloadTrustedPayrollWorkbookInput,
  dependencies: AcceptTrustedPayrollWorkbookDependencies = DEFAULT_DEPENDENCIES,
): Promise<Uint8Array<ArrayBuffer>> {
  validateDownloadInput(input);
  const trusted = dependencies.createTrustedClient();
  const downloaded = await trusted.storage.from(PAYROLL_WORKBOOK_BUCKET).download(input.storagePath);
  if (downloaded.error || !downloaded.data) {
    throw new Error("No pudimos descargar el XLSX privado.");
  }
  if (
    typeof downloaded.data.size === "number"
    && downloaded.data.size !== input.fileSize
  ) {
    throw new Error("El tamaño del XLSX privado no coincide con su evidencia.");
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== input.fileSize || actualSha256 !== input.contentSha256) {
    throw new Error("Los bytes del XLSX privado no coinciden con su evidencia.");
  }
  return bytes;
}

/**
 * Compensación server-only para una subida que no llegó a registrarse.
 * El trigger de Storage vuelve esta operación fail-closed: si un commit sí
 * alcanzó a registrar la ruta, DELETE falla y conserva la evidencia.
 */
export async function removeUnregisteredPayrollWorkbook(
  input: {
    companyId: string;
    periodStart: string;
    periodEnd: string;
    storagePath: string;
  },
  dependencies: AcceptTrustedPayrollWorkbookDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  validateStoredWorkbookPath(input);
  const trusted = dependencies.createTrustedClient();
  const removed = await trusted.storage.from(PAYROLL_WORKBOOK_BUCKET).remove([input.storagePath]);
  if (removed.error) {
    throw new Error("No se pudo limpiar la subida XLSX no registrada.");
  }
}
