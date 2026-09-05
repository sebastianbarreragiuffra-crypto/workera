export const SAFE_STAGING_FLAGS = {
  WORKERA_PROVIDER: "mock",
  WORKERA_SYNC_ENABLED: "false",
  EXPENSE_FILE_SCAN_PROVIDER: "disabled",
  EXPENSE_FILE_SCAN_ENABLED: "false",
  EXPENSE_FILE_SCAN_ALLOW_FIXTURE: "false",
  SUPPORTING_DOCUMENT_CLEANUP_ENABLED: "false",
  SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED: "false",
  EXPENSE_OCR_PROVIDER: "disabled",
  EXPENSE_OCR_ENABLED: "false",
  EXPENSE_EMAIL_CAPTURE_ENABLED: "false",
  EXPENSE_WHATSAPP_CAPTURE_ENABLED: "false",
  EXPENSE_ACCOUNTING_PROVIDER: "disabled",
  EXPENSE_ACCOUNTING_EXPORT_ENABLED: "false",
  EXPENSE_ACCOUNTING_MONITOR_EXPECT_ENABLED: "false",
  MFA_ENFORCEMENT_ENABLED: "false",
} as const;

export const STAGING_INVENTORY_SOURCES = [
  { table: "companies", dataClass: "INTERNAL", classificationRequired: false },
  { table: "profiles", dataClass: "IDENTITY", classificationRequired: true },
  { table: "employees", dataClass: "PERSONAL", classificationRequired: true },
  { table: "supporting_documents", dataClass: "SENSITIVE_HR", classificationRequired: true },
  { table: "medical_license_approvals", dataClass: "SENSITIVE_HR", classificationRequired: true },
  { table: "expense_reports", dataClass: "FINANCIAL", classificationRequired: true },
  { table: "expense_receipts", dataClass: "FINANCIAL", classificationRequired: true },
  { table: "expense_bank_transactions", dataClass: "FINANCIAL", classificationRequired: true },
] as const;

export type StagingInventoryTable = typeof STAGING_INVENTORY_SOURCES[number]["table"];
export type StagingInventoryOutcome =
  | "CONFIGURATION_DRIFT"
  | "INVENTORY_INCOMPLETE"
  | "REQUIRES_CLASSIFICATION"
  | "READY_FOR_SYNTHETIC_SEED";

export interface StagingTableObservation {
  readonly table: StagingInventoryTable;
  readonly count: number | null;
  readonly errorCode: string | null;
}

export interface StagingFlagDrift {
  readonly name: keyof typeof SAFE_STAGING_FLAGS;
  readonly expected: string;
  readonly state: "MISSING" | "UNSAFE_VALUE";
}

export interface StagingDataInventoryReport {
  readonly generatedAt: string;
  readonly outcome: StagingInventoryOutcome;
  readonly flagDrift: readonly StagingFlagDrift[];
  readonly observations: readonly StagingTableObservation[];
  readonly rowsRequiringClassification: number;
  readonly constraints: readonly string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

function validateObservations(
  observations: readonly StagingTableObservation[],
): void {
  const expected = STAGING_INVENTORY_SOURCES.map((source) => source.table).sort();
  const actual = observations.map((observation) => observation.table).sort();
  if (new Set(actual).size !== actual.length || expected.join("|") !== actual.join("|")) {
    throw new Error("El inventario de staging debe cubrir exactamente la allowlist declarada.");
  }
  for (const observation of observations) {
    if (observation.count !== null && (!Number.isSafeInteger(observation.count) || observation.count < 0)) {
      throw new Error("El inventario de staging contiene un conteo inválido.");
    }
    if ((observation.count === null) === (observation.errorCode === null)) {
      throw new Error("Cada observación debe contener un conteo o un código de error, nunca ambos.");
    }
  }
}

export function buildStagingDataInventoryReport(
  environment: Environment,
  observations: readonly StagingTableObservation[],
  generatedAt = new Date().toISOString(),
): StagingDataInventoryReport {
  validateObservations(observations);
  const flagDrift = Object.entries(SAFE_STAGING_FLAGS).flatMap(([name, expected]) => {
    const actual = environment[name];
    if (actual === expected) return [];
    return [{
      name: name as keyof typeof SAFE_STAGING_FLAGS,
      expected,
      state: actual === undefined || actual === "" ? "MISSING" : "UNSAFE_VALUE",
    } as const];
  });
  const errors = observations.filter((observation) => observation.errorCode !== null);
  const rowsRequiringClassification = observations.reduce((total, observation) => {
    const source = STAGING_INVENTORY_SOURCES.find((candidate) => candidate.table === observation.table)!;
    return total + (source.classificationRequired ? observation.count ?? 0 : 0);
  }, 0);
  const outcome: StagingInventoryOutcome = flagDrift.length > 0
    ? "CONFIGURATION_DRIFT"
    : errors.length > 0
      ? "INVENTORY_INCOMPLETE"
      : rowsRequiringClassification > 0
        ? "REQUIRES_CLASSIFICATION"
        : "READY_FOR_SYNTHETIC_SEED";

  return {
    generatedAt,
    outcome,
    flagDrift,
    observations,
    rowsRequiringClassification,
    constraints: [
      "Este reporte solo contiene conteos agregados y no prueba que una fila sea sintética.",
      "No aplicar migraciones, borrar filas ni habilitar proveedores a partir de este reporte.",
      "Privacy/Platform deben registrar la clasificación y disposición fuera del repositorio.",
    ],
  };
}

export function renderStagingDataInventoryReport(
  report: StagingDataInventoryReport,
): string {
  const lines = [
    "GESTORA — preflight de datos de staging (solo lectura)",
    `Resultado: ${report.outcome}`,
    `Generado: ${report.generatedAt}`,
    "",
    `Flags seguros: ${Object.keys(SAFE_STAGING_FLAGS).length - report.flagDrift.length}/${Object.keys(SAFE_STAGING_FLAGS).length}`,
    ...report.flagDrift.map((drift) => `  - ${drift.name}: ${drift.state}; esperado ${drift.expected}`),
    "",
    "Conteos agregados:",
    ...report.observations.map((observation) => observation.errorCode === null
      ? `  - ${observation.table}: ${observation.count}`
      : `  - ${observation.table}: ERROR ${observation.errorCode}`),
    `Filas que requieren clasificación: ${report.rowsRequiringClassification}`,
    "",
    ...report.constraints.map((constraint) => `! ${constraint}`),
  ];
  return lines.join("\n");
}
