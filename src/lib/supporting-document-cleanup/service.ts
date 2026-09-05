import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import { readSupportingDocumentCleanupStaleSeconds } from "./config";
import { SupabaseSupportingDocumentCleanupRepository } from "./repository";
import type { SupportingDocumentCleanupHealth } from "./repository";
import {
  runSupportingDocumentCleanupWorker,
  type SupportingDocumentCleanupSummary,
} from "./worker";

export interface SupportingDocumentCleanupOperationsResult {
  summary: SupportingDocumentCleanupSummary;
  health: SupportingDocumentCleanupHealth;
}

export async function runSupportingDocumentCleanupWithServiceRole(): Promise<SupportingDocumentCleanupOperationsResult> {
  const repository = new SupabaseSupportingDocumentCleanupRepository(
    createAdminClient("supporting-document-cleanup"),
  );
  const summary = await runSupportingDocumentCleanupWorker(repository);
  const health = await repository.getHealth(readSupportingDocumentCleanupStaleSeconds());
  return { summary, health };
}
