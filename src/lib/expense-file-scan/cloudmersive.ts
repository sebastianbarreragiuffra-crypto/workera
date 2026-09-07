import "server-only";
import { z } from "zod";
import type { ExpenseFileScanConfig } from "./config";
import { ExpenseFileScanError } from "./errors";
import type { ExpenseFileScanner, ExpenseFileScanInput, ExpenseFileScanVerdict } from "./scanner";

const MAX_RESPONSE_BYTES = 64 * 1024;
const RETRY_AFTER_MIN_SECONDS = 30;
const RETRY_AFTER_MAX_SECONDS = 3600;
const JSON_MEDIA_TYPES = new Set(["application/json", "text/json"]);

const responseSchema = z.object({
  CleanResult: z.boolean(),
  FoundViruses: z.array(z.unknown()).optional(),
  ContainsExecutable: z.boolean().optional(),
  ContainsInvalidFile: z.boolean().optional(),
  ContainsScript: z.boolean().optional(),
  ContainsPasswordProtectedFile: z.boolean().optional(),
  ContainsRestrictedFileFormat: z.boolean().optional(),
  ContainsMacros: z.boolean().optional(),
  ContainsXmlExternalEntities: z.boolean().optional(),
  ContainsInsecureDeserialization: z.boolean().optional(),
  ContainsHtml: z.boolean().optional(),
  ContainsUnsafeArchive: z.boolean().optional(),
  ContainsOleEmbeddedObject: z.boolean().optional(),
  ContainsUnwantedAction: z.boolean().optional(),
});

type CloudmersiveConfig = Extract<ExpenseFileScanConfig, { provider: "cloudmersive-advanced" }>;
type Fetcher = typeof fetch;

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

function retryAfterSeconds(value: string | null, now = Date.now()): number {
  if (value) {
    const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
    if (Number.isFinite(seconds)) {
      return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, seconds));
    }
  }
  return RETRY_AFTER_MIN_SECONDS;
}

async function readLimitedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isPolicyRejected(result: z.infer<typeof responseSchema>): boolean {
  return Object.entries(result).some(([key, value]) => key.startsWith("Contains") && value === true);
}

export class CloudmersiveAdvancedScanner implements ExpenseFileScanner {
  readonly name = "cloudmersive-advanced-v1";

  constructor(
    private readonly config: CloudmersiveConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async scan(input: ExpenseFileScanInput): Promise<ExpenseFileScanVerdict> {
    const extension = MIME_EXTENSION[input.mimeType];
    if (!extension) {
      throw new ExpenseFileScanError("UNSUPPORTED_MIME", "Tipo de archivo no permitido.", false);
    }

    const form = new FormData();
    form.set(
      "inputFile",
      new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
      `quarantined.${extension}`,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(`${this.config.origin}/virus/scan/file/advanced`, {
        method: "POST",
        redirect: "error",
        headers: {
          Apikey: this.config.apiKey,
          allowExecutables: "false",
          allowInvalidFiles: "false",
          allowScripts: "false",
          allowPasswordProtectedFiles: "false",
          allowMacros: "false",
          allowXmlExternalEntities: "false",
          allowInsecureDeserialization: "false",
          allowHtml: "false",
          allowUnsafeArchives: "false",
          allowOleEmbeddedObject: "false",
          allowUnwantedAction: "false",
          restrictFileTypes: ".pdf,.jpg,.jpeg,.png",
        },
        body: form,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new ExpenseFileScanError(
          "SCANNER_CONFIGURATION",
          "Credencial antimalware rechazada.",
          true,
          300,
        );
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new ExpenseFileScanError(
          "SCANNER_FAILURE",
          "El proveedor antimalware no está disponible.",
          true,
          retryAfterSeconds(response.headers.get("retry-after")),
        );
      }
      if (!response.ok) {
        throw new ExpenseFileScanError("SCANNER_FAILURE", "El proveedor rechazó la solicitud.", false);
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (!mediaType || !JSON_MEDIA_TYPES.has(mediaType)) {
        throw new ExpenseFileScanError(
          "SCANNER_FAILURE",
          "El proveedor devolvió un contrato inválido.",
          true,
          RETRY_AFTER_MIN_SECONDS,
        );
      }

      let result: z.infer<typeof responseSchema>;
      try {
        result = responseSchema.parse(await readLimitedJson(response));
      } catch (cause) {
        throw new ExpenseFileScanError(
          "SCANNER_FAILURE",
          "El proveedor devolvió un contrato inválido.",
          true,
          RETRY_AFTER_MIN_SECONDS,
          { cause },
        );
      }
      if (isPolicyRejected(result)) return { verdict: "REJECTED", resultCode: "POLICY_REJECTED" };
      if (!result.CleanResult || (result.FoundViruses?.length ?? 0) > 0) {
        return { verdict: "REJECTED", resultCode: "MALWARE_DETECTED" };
      }
      return { verdict: "CLEAN", resultCode: "CLOUDMERSIVE_CLEAN" };
    } catch (cause) {
      if (cause instanceof ExpenseFileScanError) throw cause;
      throw new ExpenseFileScanError(
        "SCANNER_FAILURE",
        "El proveedor antimalware no respondió.",
        true,
        RETRY_AFTER_MIN_SECONDS,
        { cause },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
