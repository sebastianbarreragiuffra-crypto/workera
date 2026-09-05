import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import {
  runSupportingDocumentCleanupWithServiceRole,
  type SupportingDocumentCleanupOperationsResult,
} from "@/lib/supporting-document-cleanup/service";

export const maxDuration = 30;

export function isAuthorizedSupportingDocumentCleanupCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export function supportingDocumentCleanupHttpStatus(
  result: SupportingDocumentCleanupOperationsResult,
): number {
  return result.health.requiresAttention ? 503 : 200;
}

export async function handleSupportingDocumentCleanup(
  request: NextRequest,
  runCleanup: () => Promise<SupportingDocumentCleanupOperationsResult> = runSupportingDocumentCleanupWithServiceRole,
) {
  if (!isAuthorizedSupportingDocumentCleanupCron(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  if (process.env.SUPPORTING_DOCUMENT_CLEANUP_ENABLED !== "true") {
    return NextResponse.json({
      enabled: false,
      reason: "SUPPORTING_DOCUMENT_CLEANUP_ENABLED is not true",
    });
  }
  const correlationId = randomUUID();
  try {
    const result = await runCleanup();
    return NextResponse.json(
      { enabled: true, ...result, correlationId },
      { status: supportingDocumentCleanupHttpStatus(result) },
    );
  } catch (error) {
    console.error("[supporting-document-cleanup]", {
      event: "cleanup_run_failed",
      correlationId,
      errorCode: "CLEANUP_RUN_FAILED",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "Fallo interno limpiando documentos laborales huerfanos.",
        errorCode: "CLEANUP_RUN_FAILED",
        correlationId,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleSupportingDocumentCleanup(request);
}
