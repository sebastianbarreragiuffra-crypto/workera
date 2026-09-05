export interface MigrationOrderViolation {
  path: string;
  reason: "INVALID_NAME" | "NOT_AFTER_BASE" | "DUPLICATE_VERSION";
}

const MIGRATION_PATH = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/;

function versionOf(path: string): string | null {
  return MIGRATION_PATH.exec(path)?.[1] ?? null;
}

export function validateAddedMigrationOrder(
  basePaths: readonly string[],
  headPaths: readonly string[],
  addedPaths: readonly string[],
): MigrationOrderViolation[] {
  const baseVersions = basePaths.map(versionOf).filter((value): value is string => value !== null);
  const maximumBaseVersion = [...baseVersions].sort().at(-1) ?? null;
  const versionCounts = new Map<string, number>();
  for (const path of headPaths) {
    const version = versionOf(path);
    if (version) versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
  }

  return addedPaths.flatMap((path): MigrationOrderViolation[] => {
    const version = versionOf(path);
    if (!version) return [{ path, reason: "INVALID_NAME" }];
    const violations: MigrationOrderViolation[] = [];
    if (maximumBaseVersion !== null && version <= maximumBaseVersion) {
      violations.push({ path, reason: "NOT_AFTER_BASE" });
    }
    if ((versionCounts.get(version) ?? 0) > 1) {
      violations.push({ path, reason: "DUPLICATE_VERSION" });
    }
    return violations;
  });
}
