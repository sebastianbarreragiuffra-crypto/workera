import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { SupabaseSupportingDocumentCleanupRepository } from "./repository";
import {
  runSupportingDocumentCleanupWorker,
  type SupportingDocumentCleanupSummary,
} from "./worker";

export async function runSupportingDocumentCleanupWithServiceRole(): Promise<SupportingDocumentCleanupSummary> {
  return runSupportingDocumentCleanupWorker(
    new SupabaseSupportingDocumentCleanupRepository(
      createAdminClient("supporting-document-cleanup"),
    ),
  );
}
