import "server-only";

type Environment = Readonly<Record<string, string | undefined>>;

export function readSupportingDocumentCleanupStaleSeconds(
  env: Environment = process.env,
): number {
  const raw = env.SUPPORTING_DOCUMENT_CLEANUP_STALE_SECONDS;
  if (raw === undefined || raw === "") return 93600;
  if (!/^\d+$/.test(raw)) {
    throw new Error("SUPPORTING_DOCUMENT_CLEANUP_STALE_SECONDS invalido.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 3600 || value > 604800) {
    throw new Error("SUPPORTING_DOCUMENT_CLEANUP_STALE_SECONDS invalido.");
  }
  return value;
}
