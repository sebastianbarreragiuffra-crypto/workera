import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "../supabase/admin-client";

const PAYROLL_WORKBOOK_BUCKET = "payroll-workbooks";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface TrustedPayrollCloseClient {
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{
        data: { arrayBuffer(): Promise<ArrayBuffer> } | null;
        error: { message: string } | null;
      }>;
    };
  };
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
}

type TrustedPayrollCloseRpcResult = Awaited<ReturnType<TrustedPayrollCloseClient["rpc"]>>;

async function runIdempotentCloseRpcWithTransportRetry(
  call: () => Promise<TrustedPayrollCloseRpcResult>,
): Promise<TrustedPayrollCloseRpcResult> {
  let first: TrustedPayrollCloseRpcResult;
  try {
    first = await call();
  } catch {
    return call();
  }
  if (first.error && !first.error.code?.trim()) return call();
  return first;
}

export interface FinalizePreparedPayrollCloseInput {
  operationId: string;
  storagePath: string;
  expectedContentSha256: string;
  expectedFileSize: number;
}

export interface FinalizePreparedPayrollCloseDependencies {
  createTrustedClient(): TrustedPayrollCloseClient;
}

const DEFAULT_DEPENDENCIES: FinalizePreparedPayrollCloseDependencies = {
  createTrustedClient: () => createAdminClient("payroll-period-close") as unknown as TrustedPayrollCloseClient,
};

/**
 * Frontera privilegiada mínima del cierre.
 *
 * El RPC de sesión prepara una operación corta después de validar actor, MFA,
 * empresa, revisión de fuentes, período y base aceptada. Esta frontera no
 * decide nada de eso: descarga el objeto que ya quedó reservado, calcula el
 * SHA-256 sobre sus bytes reales y entrega esa comprobación al único RPC que
 * puede confirmar el cierre. Una sesión autenticada no puede invocar ese RPC.
 */
export async function finalizePreparedPayrollClose(
  input: FinalizePreparedPayrollCloseInput,
  dependencies: FinalizePreparedPayrollCloseDependencies = DEFAULT_DEPENDENCIES
): Promise<string> {
  if (!SHA256_PATTERN.test(input.expectedContentSha256) || !Number.isSafeInteger(input.expectedFileSize)) {
    throw new Error("La evidencia del snapshot preparada no es válida.");
  }

  const trusted = dependencies.createTrustedClient();
  const downloaded = await trusted.storage.from(PAYROLL_WORKBOOK_BUCKET).download(input.storagePath);
  if (downloaded.error || !downloaded.data) {
    throw new Error("No pudimos verificar los bytes guardados del snapshot.");
  }

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const actualContentSha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  if (
    bytes.byteLength !== input.expectedFileSize ||
    actualContentSha256 !== input.expectedContentSha256
  ) {
    throw new Error("El objeto guardado no coincide con el snapshot preparado.");
  }

  const rpcArgs = {
    p_operation_id: input.operationId,
    p_verified_content_sha256: actualContentSha256,
    p_verified_file_size: bytes.byteLength,
  };
  const committed = await runIdempotentCloseRpcWithTransportRetry(
    () => trusted.rpc("commit_payroll_period_close", rpcArgs),
  );
  if (committed.error || typeof committed.data !== "string") {
    const error = new Error("No pudimos confirmar el cierre atómico del período.");
    Object.assign(error, { code: committed.error?.code });
    throw error;
  }
  return committed.data;
}
