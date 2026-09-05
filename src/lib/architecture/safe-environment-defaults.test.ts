import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function readExampleEnvironment(filename: string): Map<string, string> {
  const source = readFileSync(path.join(REPO_ROOT, filename), "utf8");
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

test("la configuracion de ejemplo mantiene inactivos los proveedores reales", () => {
  const safeDefaults = {
    WORKERA_PROVIDER: "mock",
    WORKERA_SYNC_ENABLED: "false",
    EXPENSE_FILE_SCAN_ENABLED: "false",
    EXPENSE_FILE_SCAN_PROVIDER: "disabled",
    EXPENSE_FILE_SCAN_ALLOW_FIXTURE: "false",
    SUPPORTING_DOCUMENT_CLEANUP_ENABLED: "false",
    SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED: "false",
    EXPENSE_OCR_ENABLED: "false",
    EXPENSE_OCR_PROVIDER: "disabled",
    EXPENSE_EMAIL_CAPTURE_ENABLED: "false",
    EXPENSE_WHATSAPP_CAPTURE_ENABLED: "false",
    EXPENSE_ACCOUNTING_EXPORT_ENABLED: "false",
    EXPENSE_ACCOUNTING_PROVIDER: "disabled",
    EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED: "false",
  } as const;

  for (const filename of [".env.example", ".env.staging.example"]) {
    const values = readExampleEnvironment(filename);
    for (const [name, expected] of Object.entries(safeDefaults)) {
      assert.equal(
        values.get(name),
        expected,
        `${filename}: ${name} debe fallar cerrado por defecto`,
      );
    }
  }
});

test("MFA falla cerrado en instalaciones nuevas y permanece activo en staging", () => {
  assert.equal(
    readExampleEnvironment(".env.example").get("MFA_ENFORCEMENT_ENABLED"),
    "false",
    ".env.example: MFA debe partir apagado hasta completar la ceremonia de enrolamiento",
  );
  assert.equal(
    readExampleEnvironment(".env.staging.example").get("MFA_ENFORCEMENT_ENABLED"),
    "true",
    ".env.staging.example: staging ya tiene guardas AAL2 y debe mantener alineado el gate de aplicación",
  );
});

test("los archivos de ejemplo nunca contienen credenciales ni secretos", () => {
  for (const filename of [".env.example", ".env.staging.example"]) {
    const values = readExampleEnvironment(filename);
    const secretNames = [...values.keys()].filter((name) =>
      /(?:_KEY|_SECRET|_TOKEN)$/.test(name)
    );
    assert.ok(secretNames.length > 0, `${filename}: la prueba debe encontrar placeholders sensibles`);
    for (const name of secretNames) {
      assert.equal(values.get(name), "", `${filename}: ${name} debe ser un placeholder vacio`);
    }
  }
});
