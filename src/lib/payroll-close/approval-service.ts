import "server-only";

import { createAdminClient } from "../supabase/admin-client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface TrustedPayrollApprovalClient {
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
}

export interface CommitPayrollPeriodApprovalInput {
  actorId: string;
  companyId: string;
  reportingPeriodId: string;
  expectedStatus: "IN_REVIEW" | "REOPENED";
  expectedSourceRevision: number;
  expectedAcceptedVersionId: string;
  readinessSha256: string;
}

export interface CommitPayrollPeriodApprovalDependencies {
  createTrustedClient(): TrustedPayrollApprovalClient;
}

const DEFAULT_DEPENDENCIES: CommitPayrollPeriodApprovalDependencies = {
  createTrustedClient: () =>
    createAdminClient("payroll-period-close") as unknown as TrustedPayrollApprovalClient,
};

/**
 * Frontera server-only que transforma una comprobación completa y estable en
 * la aprobación empresarial. El RPC vuelve a validar actor, tenant, versión,
 * conflictos y revisión de fuentes dentro del mismo lock que cambia estado.
 * Una sesión autenticada no puede invocarlo directamente.
 */
export async function commitPayrollPeriodApproval(
  input: CommitPayrollPeriodApprovalInput,
  dependencies: CommitPayrollPeriodApprovalDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  if (
    !UUID_PATTERN.test(input.actorId)
    || !UUID_PATTERN.test(input.companyId)
    || !UUID_PATTERN.test(input.reportingPeriodId)
    || !UUID_PATTERN.test(input.expectedAcceptedVersionId)
  ) {
    throw new Error("La identidad de la aprobación de pre-nómina no es válida.");
  }
  if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0) {
    throw new Error("La revisión de fuentes de la aprobación no es válida.");
  }
  if (!SHA256_PATTERN.test(input.readinessSha256)) {
    throw new Error("La evidencia de conciliación de la aprobación no es válida.");
  }

  const trusted = dependencies.createTrustedClient();
  const committed = await trusted.rpc("approve_reporting_period_ready", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_reporting_period_id: input.reportingPeriodId,
    p_expected_status: input.expectedStatus,
    p_expected_source_revision: input.expectedSourceRevision,
    p_expected_accepted_version_id: input.expectedAcceptedVersionId,
    p_readiness_sha256: input.readinessSha256,
  });
  if (committed.error || typeof committed.data !== "string" || !UUID_PATTERN.test(committed.data)) {
    const error = new Error(
      committed.error?.code === "40001"
        ? "Los datos de pago cambiaron durante la aprobación. Recarga y vuelve a comprobarlos."
        : "No pudimos registrar la aprobación atómica de RR. HH.",
    );
    Object.assign(error, { code: committed.error?.code });
    throw error;
  }
  return committed.data;
}
