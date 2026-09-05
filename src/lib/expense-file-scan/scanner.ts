import "server-only";

export interface ExpenseFileScanInput {
  bytes: ArrayBuffer;
  mimeType: string;
  checksumSha256: string;
}

export interface ExpenseFileScanVerdict {
  verdict: "CLEAN" | "REJECTED";
  resultCode: string;
}

export interface ExpenseFileScanner {
  readonly name: string;
  scan(input: ExpenseFileScanInput): Promise<ExpenseFileScanVerdict>;
}

const TEST_CANARY = new TextEncoder().encode("GESTORA_TEST_MALWARE_CANARY");

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Simulador exclusivamente local. El marcador NO es una firma antivirus real:
 * permite probar los caminos CLEAN/REJECTED sin enviar archivos a un tercero.
 */
export class FixtureExpenseFileScanner implements ExpenseFileScanner {
  readonly name = "fixture-scanner-v1";

  async scan(input: ExpenseFileScanInput): Promise<ExpenseFileScanVerdict> {
    if (containsBytes(new Uint8Array(input.bytes), TEST_CANARY)) {
      return { verdict: "REJECTED", resultCode: "TEST_CANARY_DETECTED" };
    }
    return { verdict: "CLEAN", resultCode: "NO_TEST_CANARY" };
  }
}
