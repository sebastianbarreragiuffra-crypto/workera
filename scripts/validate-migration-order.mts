import { execFileSync } from "node:child_process";
import { validateAddedMigrationOrder } from "../src/lib/architecture/migration-order";

function git(args: readonly string[]): string[] {
  const output = execFileSync("git", args, { encoding: "utf8" }).trim();
  return output === "" ? [] : output.split(/\r?\n/).filter(Boolean);
}

function resolveBase(raw: string | undefined): string | null {
  if (raw && /^[0-9a-f]{40}$/i.test(raw) && !/^0{40}$/.test(raw)) {
    try {
      execFileSync("git", ["cat-file", "-e", `${raw}^{commit}`], { stdio: "ignore" });
      return raw;
    } catch {
      throw new Error("El commit base de migraciones no existe en el checkout.");
    }
  }
  try {
    return git(["rev-parse", "HEAD^"])[0] ?? null;
  } catch {
    return null;
  }
}

const base = resolveBase(process.argv[2] ?? process.env.MIGRATION_BASE_SHA);
if (!base) {
  console.log("Sin commit base: no hay migraciones previas que comparar.");
  process.exit(0);
}

const migrationPathspec = "supabase/migrations/*.sql";
const basePaths = git(["ls-tree", "-r", "--name-only", base, "--", migrationPathspec]);
const headPaths = git(["ls-tree", "-r", "--name-only", "HEAD", "--", migrationPathspec]);
const addedPaths = git(["diff", "--diff-filter=A", "--name-only", base, "HEAD", "--", migrationPathspec]);
const violations = validateAddedMigrationOrder(basePaths, headPaths, addedPaths);

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`Migracion rechazada (${violation.reason}): ${violation.path}`);
  }
  process.exit(1);
}

console.log(`Orden de migraciones valido: ${addedPaths.length} archivo(s) nuevo(s).`);
