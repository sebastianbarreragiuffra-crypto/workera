import assert from "node:assert/strict";
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
import {
  approvePayrollPeriodReady,
  payrollReadinessDigest,
  PayrollPeriodApprovalBlockedError,
  type ApprovePayrollPeriodDependencies,
} from "./payroll-period-approval";

const COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PERIOD_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const PERIOD = resolvePayrollPeriod("2026-09");
const AUTHORIZED_EMPLOYEE_IDS = Array.from({ length: ARCOTEX_AUTHORIZED_ROSTER_SIZE }, (_, index) =>
  `a7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
);
const AUTHORIZED_ROSTER = {
  employeeIds: AUTHORIZED_EMPLOYEE_IDS,
  employeeCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  expectedEmployeeCodeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
} satisfies ArcotexAuthorizedRoster;
const READY: AttendanceExportCloseReadiness = { ready: true, pendingCount: 0, issues: [] };

interface MockOptions {
  periodStatus?: string;
  periodStart?: string;
  periodEnd?: string;
  acceptedVersionId?: string | null;
  openConflict?: boolean;
  sourceRevision?: number;
}

function mockSupabase(options: MockOptions = {}) {
  const calls: Array<{ kind: string; args?: unknown }> = [];
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
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          calls.push({ kind: `select:${table}`, args: filters });
          const result = table === "payroll_workbook_conflicts"
            ? { data: options.openConflict ? [{ id: "conflict" }] : [], error: null }
            : { data: [], error: null };
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
        async maybeSingle() {
          calls.push({ kind: `select:${table}`, args: filters });
          if (table === "reporting_periods") {
            return {
              data: {
                id: PERIOD_ID,
                period_start: options.periodStart ?? PERIOD.startDate,
                period_end: options.periodEnd ?? PERIOD.endDate,
                status: options.periodStatus ?? "IN_REVIEW",
              },
              error: null,
            };
          }
          if (table === "payroll_workbook_versions") {
            const id = options.acceptedVersionId === undefined ? VERSION_ID : options.acceptedVersionId;
            return { data: id ? { id } : null, error: null };
          }
          throw new Error(`tabla inesperada ${table}`);
        },
      };
      return query;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ kind: `rpc:${name}`, args });
      if (name === "get_payroll_source_revision") {
        return { data: options.sourceRevision ?? 29, error: null };
      }
      throw new Error(`RPC inesperado ${name}`);
    },
  };
  // El mock implementa únicamente la superficie consultada por la aprobación.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

function exportData(overrides: Partial<AttendanceExportData> = {}): AttendanceExportData {
  return {
    period: PERIOD,
    days: [],
    workers: [],
    holidays: new Set(),
    reportingPeriodStatus: "IN_REVIEW",
    ruleEngineProblemDates: new Set(),
    companyId: COMPANY_ID,
    rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    rosterSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
    ...overrides,
  };
}

function dependencies(overrides: Partial<ApprovePayrollPeriodDependencies> = {}) {
  const commits: unknown[] = [];
  const buildCalls: unknown[] = [];
  const adjustment = {
    employeeId: "55555555-5555-4555-8555-555555555555",
    field: "Ajuste bono (CLP)" as const,
    value: 0,
    sourceValueAtAcceptance: 1000,
    versionNumber: 4,
    decidedAt: "2026-09-06T12:00:00Z",
  };
  const deps: ApprovePayrollPeriodDependencies = {
    buildExportData: async (_supabase, _callerRole, _period, _companyId, options) => {
      buildCalls.push(options);
      return exportData();
    },
    loadAdjustments: async () => [adjustment],
    getReadiness(data) {
      assert.equal(data.reportingPeriodStatus, "READY_TO_CLOSE");
      assert.equal(data.workbookBaseVersionId, VERSION_ID);
      assert.deepEqual(data.workbookAdjustments, [adjustment]);
      return READY;
    },
    commitApproval: async (input) => {
      commits.push(input);
      return APPROVAL_ID;
    },
    resolveAuthorizedRoster: () => AUTHORIZED_ROSTER,
    ...overrides,
  };
  return { deps, commits, buildCalls };
}

const INPUT = {
  actorId: ACTOR_ID,
  companyId: COMPANY_ID,
  reportingPeriodId: PERIOD_ID,
  from: "IN_REVIEW" as const,
  callerRole: "ADMIN_RRHH" as const,
};

test("aprobación: recalcula, reaplica ajustes y entrega revisión/base a un commit atómico", async () => {
  const { client } = mockSupabase();
  const { deps, commits, buildCalls } = dependencies();
  const result = await approvePayrollPeriodReady(client, INPUT, deps);
  const readinessSha256 = payrollReadinessDigest({
    companyId: COMPANY_ID,
    periodId: PERIOD_ID,
    periodStart: PERIOD.startDate,
    periodEnd: PERIOD.endDate,
    sourceRevision: 29,
    acceptedVersionId: VERSION_ID,
    readiness: READY,
    rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    rosterSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  });
  assert.deepEqual(result, { approvalId: APPROVAL_ID, sourceRevision: 29, acceptedVersionId: VERSION_ID });
  assert.deepEqual(buildCalls, [{
    employeeIds: AUTHORIZED_EMPLOYEE_IDS,
    expectedEmployeeCodeSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  }]);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    actorId: ACTOR_ID,
    companyId: COMPANY_ID,
    reportingPeriodId: PERIOD_ID,
    expectedStatus: "IN_REVIEW",
    expectedSourceRevision: 29,
    expectedAcceptedVersionId: VERSION_ID,
    readinessSha256,
  });
  assert.match(readinessSha256, /^[a-f0-9]{64}$/);
});

test("aprobación: bloquea si el recálculo no acredita exactamente el padrón ARCOTEX de 45 y su huella", async () => {
  for (const data of [
    exportData({ rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE - 1 }),
    exportData({ rosterSha256: "f".repeat(64) }),
  ]) {
    const { client } = mockSupabase();
    const { deps, commits } = dependencies({ buildExportData: async () => data });
    await assert.rejects(
      () => approvePayrollPeriodReady(client, INPUT, deps),
      /45 personas autorizadas de Arcotex/i,
    );
    assert.deepEqual(commits, []);
  }
});

test("aprobación: la evidencia criptográfica vincula tanto cantidad como huella del padrón", () => {
  const input = {
    companyId: COMPANY_ID,
    periodId: PERIOD_ID,
    periodStart: PERIOD.startDate,
    periodEnd: PERIOD.endDate,
    sourceRevision: 29,
    acceptedVersionId: VERSION_ID,
    readiness: READY,
    rosterCount: ARCOTEX_AUTHORIZED_ROSTER_SIZE,
    rosterSha256: ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  };
  const digest = payrollReadinessDigest(input);
  assert.notEqual(digest, payrollReadinessDigest({ ...input, rosterCount: null }));
  assert.notEqual(digest, payrollReadinessDigest({ ...input, rosterSha256: "f".repeat(64) }));
});

test("aprobación: pendientes o conflictos bloquean antes del límite privilegiado", async () => {
  for (const scenario of [
    {
      mock: {},
      readiness: { ready: false, pendingCount: 1, issues: ["Marcación incompleta"] },
    },
    {
      mock: { openConflict: true },
      readiness: { ready: true, pendingCount: 0, issues: [] },
    },
  ]) {
    const { client } = mockSupabase(scenario.mock);
    const { deps, commits } = dependencies({ getReadiness: () => scenario.readiness });
    await assert.rejects(() => approvePayrollPeriodReady(client, INPUT, deps), PayrollPeriodApprovalBlockedError);
    assert.deepEqual(commits, []);
  }
});

test("aprobación: exige versión aceptada, rango 16-15, rol y estado esperado", async () => {
  const cases = [
    { mock: { acceptedVersionId: null }, input: INPUT, message: /versión.*antes de aprobar/i },
    { mock: { periodStart: "2026-09-01", periodEnd: "2026-09-30" }, input: INPUT, message: /16-15/ },
    { mock: {}, input: { ...INPUT, callerRole: "SUPER_ADMIN" as const }, message: /Solo RR\. HH\./ },
    { mock: { periodStatus: "OPEN" }, input: INPUT, message: /cambió/i },
  ];
  for (const item of cases) {
    const { client } = mockSupabase(item.mock);
    const { deps, commits } = dependencies();
    await assert.rejects(() => approvePayrollPeriodReady(client, item.input, deps), item.message);
    assert.deepEqual(commits, []);
  }
});

test("aprobación: la migración cierra bypasses, serializa fuentes y conserva historial", () => {
  const migration = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906200000_payroll_approval_and_security_hardening.sql",
  ), "utf8");
  const approvalFunction = migration.slice(
    migration.indexOf("create or replace function public.approve_reporting_period_ready"),
  );
  assert.match(migration, /create table public\.reporting_period_approvals/);
  assert.match(migration, /create trigger reporting_periods_guard_initial_state/);
  assert.match(migration, /new\.status <> 'OPEN'/);
  assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(migration, /grant execute on function public\.approve_reporting_period_ready[\s\S]*to service_role/);
  assert.match(migration, /from private\.payroll_source_revisions[\s\S]*for update/);
  assert.match(migration, /payroll_workbook_source_attestations/);
  assert.match(migration, /new\.status = 'READY_TO_CLOSE'[\s\S]*not v_trusted_approval/);
  assert.match(migration, /v_trusted_approval := coalesce\([\s\S]*false[\s\S]*\);/);
  assert.match(migration, /new\.period_start is distinct from old\.period_start/);
  assert.match(migration, /status not in \('READY_TO_CLOSE', 'CLOSED'\)/);
  assert.match(migration, /status = 'OPEN'/);
  assert.match(migration, /PAYROLL_APPROVAL_INVALIDATED_BY_SOURCE_CHANGE/);
  assert.ok(
    approvalFunction.indexOf("from private.payroll_source_revisions r")
      < approvalFunction.indexOf("from public.reporting_periods rp"),
    "la aprobación debe bloquear revisión antes que período",
  );
  assert.match(migration, /has_company_app_role\(company_id, 'ADMIN_RRHH'\)/);
  assert.match(migration, /case[\s\S]*split_part\(name, '\/', 1\)[\s\S]*then split_part\(name, '\/', 1\)::uuid/);
});
