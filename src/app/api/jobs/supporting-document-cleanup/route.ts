import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecretHeader } from "@/lib/auth/cron-secret";
import { runSupportingDocumentCleanupWithServiceRole } from "@/lib/supporting-document-cleanup/service";

export function isAuthorizedSupportingDocumentCleanupCron(request: NextRequest): boolean {
  return isValidCronSecretHeader(request.headers.get("authorization"));
}

export async function GET(request: NextRequest) {
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
    const summary = await runSupportingDocumentCleanupWithServiceRole();
    return NextResponse.json({ enabled: true, ...summary });
  } catch {
    return NextResponse.json(
      { error: "Fallo interno limpiando documentos laborales huerfanos." },
      { status: 500 },
    );
  }
}
