import "server-only";
import { isIP } from "node:net";
import { ExpenseFileScanError } from "./errors";

export type ExpenseFileScanConfig =
  | { enabled: false; provider: "disabled" }
  | { enabled: true; provider: "fixture" }
  | {
      enabled: true;
      provider: "cloudmersive-advanced";
      origin: string;
      apiKey: string;
      timeoutMs: number;
      maxFilesPerRun: number;
      maxRuntimeMs: number;
    };

type Environment = Readonly<Record<string, string | undefined>>;

const PUBLIC_CLOUDMERSIVE_HOSTS = new Set(["api.cloudmersive.com", "testapi.cloudmersive.com"]);

function parseApprovedHostname(value: string | undefined): string | null {
  if (!value) return null;
  const hostname = value.toLowerCase();
  if (
    hostname !== value
    || isIP(hostname) !== 0
    || hostname === "localhost"
    || hostname.endsWith(".local")
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
    || PUBLIC_CLOUDMERSIVE_HOSTS.has(hostname)
  ) return null;
  return hostname;
}

function parsePrivateOrigin(value: string | undefined, approvedHostname: string | null): string | null {
  if (!value || !approvedHostname) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.port
      || url.search
      || url.hash
      || url.hostname.toLowerCase() !== approvedHostname
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseTimeout(value: string | undefined): number | null {
  return parseInteger(value, 15_000, 1_000, 30_000);
}

export function readExpenseFileScanConfig(env: Environment = process.env): ExpenseFileScanConfig {
  if (env.EXPENSE_FILE_SCAN_ENABLED !== "true") {
    return { enabled: false, provider: "disabled" };
  }

  if (
    env.EXPENSE_FILE_SCAN_PROVIDER === "fixture"
    && env.EXPENSE_FILE_SCAN_ALLOW_FIXTURE === "true"
    && env.NODE_ENV !== "production"
  ) {
    return { enabled: true, provider: "fixture" };
  }

  if (env.EXPENSE_FILE_SCAN_PROVIDER === "cloudmersive-advanced") {
    const approvedHostname = parseApprovedHostname(
      env.CLOUDMERSIVE_PRIVATE_TENANT_APPROVED_HOSTNAME,
    );
    const origin = parsePrivateOrigin(
      env.CLOUDMERSIVE_PRIVATE_TENANT_ORIGIN,
      approvedHostname,
    );
    const apiKey = env.CLOUDMERSIVE_API_KEY;
    const timeoutMs = parseTimeout(env.EXPENSE_FILE_SCAN_REQUEST_TIMEOUT_MS);
    const maxFilesPerRun = parseInteger(env.EXPENSE_FILE_SCAN_MAX_FILES_PER_RUN, 10, 1, 25);
    const maxRuntimeMs = parseInteger(env.EXPENSE_FILE_SCAN_MAX_RUNTIME_MS, 45_000, 5_000, 55_000);
    if (
      env.EXPENSE_FILE_SCAN_EXTERNAL_TRANSFER_APPROVED === "true"
      && origin
      && apiKey
      && /^[\x21-\x7e]{32,256}$/.test(apiKey)
      && timeoutMs !== null
      && maxFilesPerRun !== null
      && maxRuntimeMs !== null
      && timeoutMs + 1_000 <= maxRuntimeMs
    ) {
      return {
        enabled: true,
        provider: "cloudmersive-advanced",
        origin,
        apiKey,
        timeoutMs,
        maxFilesPerRun,
        maxRuntimeMs,
      };
    }
  }

  throw new ExpenseFileScanError(
    "SCANNER_CONFIGURATION",
    "No existe un proveedor antimalware habilitable para este ambiente.",
    false,
  );
}
