import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type {
  AttendanceExportCloseReadiness,
  AttendanceExportData,
} from "../business-rules/attendance-export";
import { resolvePayrollPeriod } from "../business-rules/attendance-export-periods";
import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  type ArcotexAuthorizedRoster,
} from "../employees/arcotex-pilot-roster";
import { payrollReadinessDigest } from "./payroll-period-approval";
import {
  closePayrollPeriodWithSnapshot,
  PayrollPeriodCloseBlockedError,
  type PayrollPeriodCloseDependencies,
} from "./payroll-period-close";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";
const PERIOD_ID = "11111111-1111-4111-8111-111111111111";
const BASE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const PERIOD = resolvePayrollPeriod("2026-09");
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x47, 0x45, 0x53, 0x54, 0x4f, 0x52, 0x41]);
const AUTHORIZED_EMPLOYEE_IDS = Array.from({ length: ARCOTEX_AUTHORIZED_ROSTER_SIZE }, (_, index) =>
  `a7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);
const AUTHORIZED_ROSTER = {
  employeeIds: AUTHORIZED_EMPLOYEE_IDS,
  employeeCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  expectedEmployeeCodeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
} satisfies ArcotexAuthorizedRoster;
const READY: AttendanceExportCloseReadiness = { ready: true, pendingCount: 0, issues: [] };

function readinessDigest(
  sourceRevision = 17,
  acceptedVersionId = BASE_VERSION_ID,
): string {
  return payrollReadinessDigest({
    companyId: COMPANY_ID,
    periodId: PERIOD_ID,
    periodStart: PERIOD.startDate,
    periodEnd: PERIOD.endDate,
    sourceRevision,
    acceptedVersionId,
    readiness: READY,
    rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    rosterSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  });
}

test("cierre SQL revalida el rol ADMIN_RRHH dentro de la misma empresa", () => {
  const migration = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906150000_payroll_period_atomic_close.sql",
  ), "utf8");
  const commitFunction = migration.slice(migration.indexOf("create or replace function public.commit_payroll_period_close"));

  assert.match(commitFunction, /join public\.company_membership_roles cmr/);
  assert.match(commitFunction, /join public\.company_roles cr/);
  assert.match(commitFunction, /cr\.base_role = 'ADMIN_RRHH'/);
  assert.doesNotMatch(commitFunction, /p\.role = 'ADMIN_RRHH'/);
  assert.match(migration, /create or replace function public\.prepare_payroll_period_close[\s\S]*?request_is_aal2\(\)/);
});

interface MockOptions {
  period?: Record<string, unknown> | null;
  baseVersionId?: string | null;
  sourceRevisions?: number[];
  openConflict?: boolean;
  uploadError?: { message: string } | null;
  prepareError?: { code?: string; message: string } | null;
  existingSnapshot?: Record<string, unknown> | null;
  currentApproval?: Record<string, unknown> | null;
  approvalError?: { message: string } | null;
}

function mockSupabase(options: MockOptions = {}) {
  const calls: Array<{ kind: string; args?: unknown }> = [];
  const revisions = [...(options.sourceRevisions ?? [17, 17])];
  const initialRevision = options.sourceRevisions?.[0] ?? 17;
  const listResult = (table: string, filters: Record<string, unknown>) => {
    calls.push({ kind: `select:${table}`, args: filters });
    if (table === "payroll_workbook_conflicts") {
      return { data: options.openConflict ? [{ id: "conflict" }] : [], error: null };
    }
    return { data: [], error: null };
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { filters[column] = value; return query; },
        is(column: string, value: null) { filters[column] = value; return query; },
        order() { return query; },
        limit() { return query; },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve(listResult(table, filters)).then(onfulfilled, onrejected);
        },
        async maybeSingle() {
          calls.push({ kind: `select:${table}`, args: filters });
          if (table === "reporting_periods") {
            return {
              data: options.period === undefined
                ? {
                    id: PERIOD_ID,
                    period_start: PERIOD.startDate,
                    period_end: PERIOD.endDate,
                    status: "READY_TO_CLOSE",
                    closed_at: null,
                  }
                : options.period,
              error: null,
            };
          }
          if (table === "payroll_workbook_versions" && filters.status === "CLOSED_SNAPSHOT") {
            return { data: options.existingSnapshot ?? null, error: null };
          }
          if (table === "payroll_workbook_versions") {
            const id = options.baseVersionId === undefined ? BASE_VERSION_ID : options.baseVersionId;
            return {
              data: id ? {
                id,
                content_sha256: "a".repeat(64),
                file_size: 100,
                storage_path: `${COMPANY_ID}/${PERIOD.startDate}_${PERIOD.endDate}/accepted.xlsx`,
              } : null,
              error: null,
            };
          }
          if (table === "reporting_period_approvals") {
            return {
              data: options.currentApproval === undefined
                ? {
                    accepted_workbook_version_id: BASE_VERSION_ID,
                    source_revision: initialRevision,
                    readiness_sha256: readinessDigest(initialRevision),
                  }
                : options.currentApproval,
              error: options.approvalError ?? null,
            };
          }
          throw new Error(`Tabla inesperada: ${table}`);
        },
      };
      return query;
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "payroll-workbooks");
        return {
          async upload(path: string, bytes: Uint8Array, uploadOptions: unknown) {
            calls.push({ kind: "storage:upload", args: { path, bytes, uploadOptions } });
            return { error: options.uploadError ?? null };
          },
        };
      },
    },
    async rpc(name: string, args: unknown) {
      calls.push({ kind: `rpc:${name}`, args });
      if (name === "get_payroll_source_revision") {
        return { data: revisions.shift() ?? 17, error: null };
      }
      if (name === "prepare_payroll_period_close") {
        return options.prepareError
          ? { data: null, error: options.prepareError }
          : { data: OPERATION_ID, error: null };
      }
      if (name === "abort_payroll_period_close") {
        return { data: true, error: null };
      }
      throw new Error(`RPC inesperado: ${name}`);
    },
  };
  // El mock implementa solo la superficie que usa el protocolo de cierre.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

function exportData(overrides: Partial<AttendanceExportData> = {}): AttendanceExportData {
  return {
    period: PERIOD,
    days: [],
    workers: [],
    holidays: new Set(),
    reportingPeriodStatus: "READY_TO_CLOSE",
    ruleEngineProblemDates: new Set(),
    companyId: COMPANY_ID,
    rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    rosterSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
    ...overrides,
  };
}

function dependencies(overrides: Partial<PayrollPeriodCloseDependencies> = {}) {
  const adjustment = {
    employeeId: "55555555-5555-4555-8555-555555555555",
    field: "Ajuste HH50 (minutos)" as const,
    value: 30,
    sourceValueAtAcceptance: 0,
    versionNumber: 7,
    decidedAt: "2026-09-06T12:00:00Z",
  };
  const built: AttendanceExportData[] = [];
  const exportBuilds: unknown[] = [];
  const finalized: unknown[] = [];
  const removed: unknown[] = [];
  const deps: PayrollPeriodCloseDependencies = {
    buildExportData: async (_supabase, _callerRole, _period, _companyId, options) => {
      exportBuilds.push(options);
      return exportData();
    },
    loadAdjustments: async () => [adjustment],
    getReadiness: (data) => {
      assert.equal(data.reportingPeriodStatus, "READY_TO_CLOSE");
      assert.equal(data.workbookBaseVersionId, BASE_VERSION_ID);
      assert.deepEqual(data.workbookAdjustments, [adjustment]);
      return READY;
    },
    buildWorkbook: (data) => {
      built.push(data);
      return BYTES;
    },
    finalizePreparedClose: async (input) => {
      finalized.push(input);
      return SNAPSHOT_ID;
    },
    removeUnregisteredWorkbook: async (input) => {
      removed.push(input);
    },
    randomUuid: () => OPERATION_ID,
    resolveAuthorizedRoster: () => AUTHORIZED_ROSTER,
    ...overrides,
  };
  return { deps, built, exportBuilds, finalized, removed, adjustment };
}

test("cierre: reaplica base/ajustes, fija revisión, sube bytes CERRADOS y confirma por frontera confiable", async () => {
  const { client, calls } = mockSupabase();
  const { deps, built, exportBuilds, finalized, adjustment } = dependencies();

  const result = await closePayrollPeriodWithSnapshot(client, {
    companyId: COMPANY_ID,
    reportingPeriodId: PERIOD_ID,
    callerRole: "ADMIN_RRHH",
  }, deps);

  const sha256 = createHash("sha256").update(Buffer.from(BYTES)).digest("hex");
  assert.deepEqual(result, { snapshotVersionId: SNAPSHOT_ID, contentSha256: sha256, fileSize: BYTES.byteLength });
  assert.equal(built.length, 1);
  assert.equal(built[0].reportingPeriodStatus, "CLOSED");
  assert.equal(built[0].workbookBaseVersionId, BASE_VERSION_ID);
  assert.deepEqual(built[0].workbookAdjustments, [adjustment]);
  assert.deepEqual(exportBuilds, [{
    employeeIds: AUTHORIZED_EMPLOYEE_IDS,
    expectedEmployeeCodeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  }]);

  const path = `${COMPANY_ID}/${PERIOD.startDate}_${PERIOD.endDate}/closed/${PERIOD_ID}/${OPERATION_ID}.xlsx`;
  const currentReadinessSha256 = readinessDigest();
  const approvalCheck = calls.find((call) => call.kind === "select:reporting_period_approvals");
  const prepare = calls.find((call) => call.kind === "rpc:prepare_payroll_period_close");
  assert.deepEqual(prepare?.args, {
    p_operation_id: OPERATION_ID,
    p_company_id: COMPANY_ID,
    p_reporting_period_id: PERIOD_ID,
    p_expected_status: "READY_TO_CLOSE",
    p_expected_base_version_id: BASE_VERSION_ID,
    p_expected_source_revision: 17,
    p_expected_readiness_sha256: currentReadinessSha256,
    p_content_sha256: sha256,
    p_file_size: BYTES.byteLength,
    p_storage_path: path,
  });
  const upload = calls.find((call) => call.kind === "storage:upload");
  assert.ok(upload);
  const uploadArgs = upload.args as { path: string; uploadOptions: { metadata: Record<string, string> } };
  assert.equal(uploadArgs.path, path);
  assert.deepEqual(uploadArgs.uploadOptions.metadata, {
    artifact_kind: "CLOSED_SNAPSHOT",
    content_sha256: sha256,
    reporting_period_id: PERIOD_ID,
    period_start: PERIOD.startDate,
    period_end: PERIOD.endDate,
    operation_id: OPERATION_ID,
    base_version_id: BASE_VERSION_ID,
    source_revision: "17",
    readiness_sha256: currentReadinessSha256,
    roster_count: String(ARCOTEX_AUTHORIZED_ROSTER_SIZE),
    roster_sha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  });
  assert.deepEqual(finalized, [{
    operationId: OPERATION_ID,
    storagePath: path,
    expectedContentSha256: sha256,
    expectedFileSize: BYTES.byteLength,
  }]);
  assert.ok(approvalCheck, "el cierre debe releer la aprobación activa");
  assert.ok(calls.indexOf(approvalCheck) < calls.indexOf(prepare!), "la huella aprobada debe comprobarse antes de reservar");
  assert.ok(calls.indexOf(prepare!) < calls.indexOf(upload), "la reserva autorizada debe anteceder al objeto");
  assert.ok(!calls.some((call) => call.kind === "storage:remove"));
});

test("cierre: bloquea antes del snapshot si el recálculo no acredita las 45 personas y su huella", async () => {
  for (const data of [
    exportData({ rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE - 1 }),
    exportData({ rosterSha256: "f".repeat(64) }),
  ]) {
    const { client, calls } = mockSupabase();
    let generated = false;
    const { deps } = dependencies({
      buildExportData: async () => data,
      buildWorkbook: () => { generated = true; return BYTES; },
    });
    await assert.rejects(
      () => closePayrollPeriodWithSnapshot(client, {
        companyId: COMPANY_ID,
        reportingPeriodId: PERIOD_ID,
        callerRole: "ADMIN_RRHH",
      }, deps),
      /45 personas autorizadas de Arcotex/i,
    );
    assert.equal(generated, false);
    assert.ok(!calls.some((call) =>
      call.kind === "select:reporting_period_approvals"
      || call.kind === "rpc:prepare_payroll_period_close"
      || call.kind === "storage:upload"
    ));
  }
});

test("cierre: exige una aprobación activa con la misma versión, revisión y huella antes de almacenar", async () => {
  const matchingDigest = readinessDigest();
  const scenarios: Array<Record<string, unknown> | null> = [
    null,
    {
      accepted_workbook_version_id: "66666666-6666-4666-8666-666666666666",
      source_revision: 17,
      readiness_sha256: matchingDigest,
    },
    {
      accepted_workbook_version_id: BASE_VERSION_ID,
      source_revision: 18,
      readiness_sha256: matchingDigest,
    },
    {
      accepted_workbook_version_id: BASE_VERSION_ID,
      source_revision: 17,
      readiness_sha256: "f".repeat(64),
    },
  ];

  for (const currentApproval of scenarios) {
    const { client, calls } = mockSupabase({ currentApproval });
    let generated = false;
    const { deps } = dependencies({ buildWorkbook: () => { generated = true; return BYTES; } });
    await assert.rejects(
      () => closePayrollPeriodWithSnapshot(client, {
        companyId: COMPANY_ID,
        reportingPeriodId: PERIOD_ID,
        callerRole: "ADMIN_RRHH",
      }, deps),
      (error: unknown) =>
        error instanceof PayrollPeriodCloseBlockedError
        && /aprobación de RR\. HH\. ya no corresponde/i.test(error.message),
    );
    assert.equal(generated, false);
    assert.ok(calls.some((call) => call.kind === "select:reporting_period_approvals"));
    assert.ok(!calls.some((call) =>
      call.kind === "rpc:prepare_payroll_period_close"
      || call.kind === "storage:upload"
    ));
  }
});

test("cierre: un estado distinto de READY_TO_CLOSE falla antes de generar o subir", async () => {
  const { client, calls } = mockSupabase({
    period: { id: PERIOD_ID, period_start: PERIOD.startDate, period_end: PERIOD.endDate, status: "IN_REVIEW", closed_at: null },
  });
  let generated = false;
  const { deps } = dependencies({ buildWorkbook: () => { generated = true; return BYTES; } });

  await assert.rejects(
    () => closePayrollPeriodWithSnapshot(client, {
      companyId: COMPANY_ID,
      reportingPeriodId: PERIOD_ID,
      callerRole: "ADMIN_RRHH",
    }, deps),
    (error: unknown) => error instanceof PayrollPeriodCloseBlockedError && /Aprobado por RR\. HH\./i.test(error.message)
  );
  assert.equal(generated, false);
  assert.ok(!calls.some((call) => call.kind.startsWith("storage:") || call.kind.startsWith("rpc:")));
});

test("cierre: un reintento tras respuesta incierta recupera el snapshot del mismo closed_at", async () => {
  const closedAt = "2026-09-06T18:00:00.000Z";
  const { client, calls } = mockSupabase({
    period: { id: PERIOD_ID, period_start: PERIOD.startDate, period_end: PERIOD.endDate, status: "CLOSED", closed_at: closedAt },
    existingSnapshot: {
      id: SNAPSHOT_ID,
      content_sha256: "b".repeat(64),
      file_size: 123,
      base_version_id: BASE_VERSION_ID,
      closed_snapshot_at: closedAt,
    },
  });
  const { deps } = dependencies();
  assert.deepEqual(await closePayrollPeriodWithSnapshot(client, {
    companyId: COMPANY_ID,
    reportingPeriodId: PERIOD_ID,
    callerRole: "ADMIN_RRHH",
  }, deps), { snapshotVersionId: SNAPSHOT_ID, contentSha256: "b".repeat(64), fileSize: 123 });
  assert.ok(!calls.some((call) => call.kind.startsWith("rpc:") || call.kind.startsWith("storage:")));
});

test("cierre: rechaza un rango que no sea el período de pago exacto 16-15", async () => {
  const { client, calls } = mockSupabase({
    period: { id: PERIOD_ID, period_start: "2026-09-01", period_end: "2026-09-30", status: "READY_TO_CLOSE", closed_at: null },
  });
  const { deps } = dependencies();
  await assert.rejects(
    () => closePayrollPeriodWithSnapshot(client, {
      companyId: COMPANY_ID,
      reportingPeriodId: PERIOD_ID,
      callerRole: "ADMIN_RRHH",
    }, deps),
    /16-15/
  );
  assert.ok(!calls.some((call) => call.kind === "storage:upload"));
});

test("cierre: pendientes, alertas o conflictos persistidos bloquean el snapshot", async () => {
  for (const scenario of [
    { options: {}, readiness: { ready: false, pendingCount: 2, issues: ["Marcación incompleta"] } },
    { options: { openConflict: true }, readiness: { ready: true, pendingCount: 0, issues: [] } },
  ]) {
    const { client, calls } = mockSupabase(scenario.options);
    const { deps } = dependencies({ getReadiness: () => scenario.readiness });
    await assert.rejects(
      () => closePayrollPeriodWithSnapshot(client, {
        companyId: COMPANY_ID,
        reportingPeriodId: PERIOD_ID,
        callerRole: "ADMIN_RRHH",
      }, deps),
      PayrollPeriodCloseBlockedError
    );
    assert.ok(!calls.some((call) => call.kind === "storage:upload"));
  }
});

test("cierre: una mutación de fuentes durante el build aborta antes de preparar o subir", async () => {
  const { client, calls } = mockSupabase({ sourceRevisions: [17, 18] });
  const { deps } = dependencies();
  await assert.rejects(
    () => closePayrollPeriodWithSnapshot(client, {
      companyId: COMPANY_ID,
      reportingPeriodId: PERIOD_ID,
      callerRole: "ADMIN_RRHH",
    }, deps),
    /datos de pago cambiaron/i
  );
  assert.ok(!calls.some((call) => call.kind === "rpc:prepare_payroll_period_close" || call.kind === "storage:upload"));
});

test("cierre: si la confirmación confiable falla, compensa solo el objeto recién subido", async () => {
  const { client, calls } = mockSupabase();
  const failure = Object.assign(new Error("La pre-nómina cambió"), { code: "40001" });
  const { deps, removed } = dependencies({ finalizePreparedClose: async () => { throw failure; } });
  await assert.rejects(
    () => closePayrollPeriodWithSnapshot(client, {
      companyId: COMPANY_ID,
      reportingPeriodId: PERIOD_ID,
      callerRole: "ADMIN_RRHH",
    }, deps),
    /cambió durante el cierre/i
  );
  assert.deepEqual(
    calls.filter((call) => call.kind.startsWith("storage:")).map((call) => call.kind),
    ["storage:upload"]
  );
  assert.deepEqual(removed, [{
    companyId: COMPANY_ID,
    periodStart: PERIOD.startDate,
    periodEnd: PERIOD.endDate,
    storagePath: `${COMPANY_ID}/${PERIOD.startDate}_${PERIOD.endDate}/closed/${PERIOD_ID}/${OPERATION_ID}.xlsx`,
  }]);
});

test("cierre: rol o identificadores inválidos no alcanzan la base", async () => {
  for (const input of [
    { companyId: COMPANY_ID, reportingPeriodId: PERIOD_ID, callerRole: "SUPER_ADMIN" as const },
    { companyId: COMPANY_ID, reportingPeriodId: "periodo", callerRole: "ADMIN_RRHH" as const },
  ]) {
    const { client, calls } = mockSupabase();
    const { deps } = dependencies();
    await assert.rejects(() => closePayrollPeriodWithSnapshot(client, input, deps));
    assert.deepEqual(calls, []);
  }
});
