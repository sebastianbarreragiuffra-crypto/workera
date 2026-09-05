import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import {
  runSupportingDocumentCleanupWithServiceRole,
  type SupportingDocumentCleanupOperationsResult,
} from "@/lib/supporting-document-cleanup/service";

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
  try {
    const result = await runCleanup();
    return NextResponse.json(
      { enabled: true, ...result },
      { status: supportingDocumentCleanupHttpStatus(result) },
    );
  } catch {
    return NextResponse.json(
      { error: "Fallo interno limpiando documentos laborales huerfanos." },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleSupportingDocumentCleanup(request);
}
