import assert from "node:assert/strict";
import test from "node:test";
import {
  SAFE_STAGING_FLAGS,
  STAGING_INVENTORY_SOURCES,
  buildStagingDataInventoryReport,
  renderStagingDataInventoryReport,
  type StagingTableObservation,
} from "./inventory";

function observations(
  counts: Partial<Record<StagingTableObservation["table"], number>> = {},
): StagingTableObservation[] {
  return STAGING_INVENTORY_SOURCES.map((source) => ({
    table: source.table,
    count: counts[source.table] ?? 0,
    errorCode: null,
  }));
}

test("un staging vacío y con flags explícitos queda listo solo para semilla sintética", () => {
  const report = buildStagingDataInventoryReport(
    SAFE_STAGING_FLAGS,
    observations(),
    "2026-09-05T12:00:00.000Z",
  );
  assert.equal(report.outcome, "READY_FOR_SYNTHETIC_SEED");
  assert.equal(report.rowsRequiringClassification, 0);
  assert.equal(report.flagDrift.length, 0);
});

test("una fila personal exige clasificación y nunca se presume sintética", () => {
  const report = buildStagingDataInventoryReport(
    SAFE_STAGING_FLAGS,
    observations({ employees: 97, profiles: 7 }),
  );
  assert.equal(report.outcome, "REQUIRES_CLASSIFICATION");
  assert.equal(report.rowsRequiringClassification, 104);
  assert.match(renderStagingDataInventoryReport(report), /Este reporte solo contiene conteos agregados/);
});

test("un flag ausente o inseguro bloquea antes que la clasificación", () => {
  const environment = { ...SAFE_STAGING_FLAGS } as Record<string, string | undefined>;
  delete environment.EXPENSE_FILE_SCAN_ENABLED;
  environment.WORKERA_PROVIDER = "http";
  const report = buildStagingDataInventoryReport(environment, observations({ employees: 1 }));
  assert.equal(report.outcome, "CONFIGURATION_DRIFT");
  assert.deepEqual(report.flagDrift.map((item) => [item.name, item.state]), [
    ["WORKERA_PROVIDER", "UNSAFE_VALUE"],
    ["EXPENSE_FILE_SCAN_ENABLED", "MISSING"],
  ]);
});

test("una tabla no consultable deja el inventario incompleto sin filtrar mensajes", () => {
  const current = observations();
  const index = current.findIndex((item) => item.table === "expense_bank_transactions");
  current[index] = { table: "expense_bank_transactions", count: null, errorCode: "PGRST205" };
  const report = buildStagingDataInventoryReport(SAFE_STAGING_FLAGS, current);
  assert.equal(report.outcome, "INVENTORY_INCOMPLETE");
  assert.match(renderStagingDataInventoryReport(report), /expense_bank_transactions: ERROR PGRST205/);
});

test("la allowlist debe estar completa y cada observación es count xor error", () => {
  assert.throws(
    () => buildStagingDataInventoryReport(SAFE_STAGING_FLAGS, observations().slice(1)),
    /exactamente la allowlist/,
  );
  const invalid = observations();
  invalid[0] = { ...invalid[0], errorCode: "ERROR" };
  assert.throws(
    () => buildStagingDataInventoryReport(SAFE_STAGING_FLAGS, invalid),
    /conteo o un código de error/,
  );
});

test("el reporte nunca contiene nombres, ids, correos, rutas ni secretos", () => {
  const report = buildStagingDataInventoryReport(
    SAFE_STAGING_FLAGS,
    observations({ employees: 97, supporting_documents: 4, expense_receipts: 2 }),
  );
  const rendered = renderStagingDataInventoryReport(report);
  for (const forbidden of ["display_name", "email", "storage_path", "service_role", "SUPABASE_SERVICE_ROLE_KEY"]) {
    assert.doesNotMatch(rendered, new RegExp(forbidden, "i"));
  }
});
