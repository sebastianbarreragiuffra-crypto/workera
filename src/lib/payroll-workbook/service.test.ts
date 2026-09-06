import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  acceptTrustedPayrollWorkbook,
  removeUnregisteredPayrollWorkbook,
  type AcceptTrustedPayrollWorkbookInput,
} from "./service";

const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x47, 0x45, 0x53, 0x54, 0x4f, 0x52, 0x41]);
const HASH = createHash("sha256").update(Buffer.from(BYTES)).digest("hex");
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const STORAGE_IDENTITY = {
  objectId: "44444444-4444-4444-8444-444444444444",
  version: "storage-version-a",
  updatedAt: "2026-09-06T12:00:00.000Z",
};

const INPUT: AcceptTrustedPayrollWorkbookInput = {
  actorId: "11111111-1111-4111-8111-111111111111",
  companyId: "0a4c0000-0000-0000-0000-000000000001",
  periodStart: "2026-08-16",
  periodEnd: "2026-09-15",
  expectedBaseVersionId: null,
  expectedSourceRevision: 17,
  contentSha256: HASH,
  fileSize: BYTES.byteLength,
  storagePath: "0a4c0000-0000-0000-0000-000000000001/2026-08-16_2026-09-15/22222222-2222-4222-8222-222222222222.xlsx",
  generalReason: "Validación ficticia de RR. HH.",
  changes: [{ sheet: "RESUMEN_NOMINA", cell: "R6", next: 60 }],
};

function dependencies(options: {
  storedBytes?: Uint8Array;
  storedSize?: number;
  rpc?: Array<{ data: unknown; error: { code?: string; message: string } | null } | Error>;
  identities?: unknown[];
} = {}) {
  const calls: Array<{ name: string; args?: unknown }> = [];
  const replies = [...(options.rpc ?? [{ data: VERSION_ID, error: null }])];
  const identities = [...(options.identities ?? [STORAGE_IDENTITY, STORAGE_IDENTITY])];
  const storedBytes = options.storedBytes ?? BYTES;
  return {
    calls,
    deps: {
      createTrustedClient: () => ({
        storage: {
          from(bucket: string) {
            assert.equal(bucket, "payroll-workbooks");
            return {
              async download(storagePath: string) {
                calls.push({ name: "download", args: storagePath });
                return {
                  data: {
                    size: options.storedSize ?? storedBytes.byteLength,
                    arrayBuffer: async () => storedBytes.slice().buffer,
                  },
                  error: null,
                };
              },
              async remove(paths: string[]) {
                calls.push({ name: "remove", args: paths });
                return { data: [], error: null };
              },
            };
          },
        },
        async rpc(name: string, args: Record<string, unknown>) {
          calls.push({ name, args });
          if (name === "get_payroll_workbook_object_identity") {
            const identity = identities.shift();
            assert.ok(identity, "faltó una identidad Storage ficticia");
            return { data: identity, error: null };
          }
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          assert.ok(reply, "faltó una respuesta RPC ficticia");
          return reply;
        },
      }),
    },
  };
}

test("acepta solo después de descargar Storage y recalcular SHA-256/tamaño", async () => {
  const { calls, deps } = dependencies();
  const result = await acceptTrustedPayrollWorkbook(INPUT, deps);

  assert.equal(result.versionId, VERSION_ID);
  assert.equal(result.contentSha256, HASH);
  assert.equal(result.fileSize, BYTES.byteLength);
  assert.match(result.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
    "get_payroll_workbook_object_identity",
    "register_accepted_payroll_workbook",
  ]);
  assert.deepEqual(calls[3].args, {
    p_actor_id: INPUT.actorId,
    p_company_id: INPUT.companyId,
    p_period_start: INPUT.periodStart,
    p_period_end: INPUT.periodEnd,
    p_expected_base_version_id: null,
    p_content_sha256: HASH,
    p_file_size: BYTES.byteLength,
    p_storage_path: INPUT.storagePath,
    p_general_reason: INPUT.generalReason,
    p_changes: INPUT.changes,
    p_expected_source_revision: 17,
    p_verified_content_sha256: HASH,
    p_verified_file_size: BYTES.byteLength,
    p_idempotency_key: result.idempotencyKey,
    p_storage_object_id: STORAGE_IDENTITY.objectId,
    p_storage_object_version: STORAGE_IDENTITY.version,
    p_storage_object_updated_at: STORAGE_IDENTITY.updatedAt,
  });
});

test("un objeto alterado nunca alcanza el RPC de commit", async () => {
  const { calls, deps } = dependencies({ storedBytes: new Uint8Array([...BYTES, 0xff]) });
  await assert.rejects(() => acceptTrustedPayrollWorkbook(INPUT, deps), /no coinciden/i);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
    "get_payroll_workbook_object_identity",
  ]);
});

test("rechaza si el objeto Storage cambia durante la descarga", async () => {
  const changed = { ...STORAGE_IDENTITY, version: "storage-version-b" };
  const { calls, deps } = dependencies({ identities: [STORAGE_IDENTITY, changed] });
  await assert.rejects(() => acceptTrustedPayrollWorkbook(INPUT, deps), /cambió mientras/i);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
    "get_payroll_workbook_object_identity",
  ]);
});

test("rechaza por tamaño de Blob antes de materializar un objeto excesivo", async () => {
  const { calls, deps } = dependencies({ storedSize: 15 * 1024 * 1024 + 1 });
  await assert.rejects(() => acceptTrustedPayrollWorkbook(INPUT, deps), /excede/i);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
  ]);
});

test("una respuesta de transporte ambigua repite el mismo comando idempotente", async () => {
  const { calls, deps } = dependencies({ rpc: [new Error("socket closed"), { data: VERSION_ID, error: null }] });
  const result = await acceptTrustedPayrollWorkbook(INPUT, deps);
  assert.equal(result.versionId, VERSION_ID);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
    "get_payroll_workbook_object_identity",
    "register_accepted_payroll_workbook",
    "register_accepted_payroll_workbook",
  ]);
  assert.deepEqual(calls[3].args, calls[4].args);
});

test("un FetchError resuelto por PostgREST también repite el mismo comando idempotente", async () => {
  const { calls, deps } = dependencies({
    rpc: [
      { data: null, error: { code: "", message: "FetchError: socket closed" } },
      { data: VERSION_ID, error: null },
    ],
  });
  const result = await acceptTrustedPayrollWorkbook(INPUT, deps);
  assert.equal(result.versionId, VERSION_ID);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
    "get_payroll_workbook_object_identity",
    "register_accepted_payroll_workbook",
    "register_accepted_payroll_workbook",
  ]);
  assert.deepEqual(calls[3].args, calls[4].args);
});

test("un error SQL con código no se reintenta", async () => {
  const { calls, deps } = dependencies({
    rpc: [{ data: null, error: { code: "55000", message: "revision cambió" } }],
  });
  await assert.rejects(() => acceptTrustedPayrollWorkbook(INPUT, deps));
  assert.deepEqual(calls.map((call) => call.name), [
    "get_payroll_workbook_object_identity",
    "download",
    "get_payroll_workbook_object_identity",
    "register_accepted_payroll_workbook",
  ]);
});

test("la huella es estable ante el orden de propiedades y cambia ante una decisión distinta", async () => {
  const first = await acceptTrustedPayrollWorkbook(INPUT, dependencies().deps);
  const reordered = await acceptTrustedPayrollWorkbook({
    ...INPUT,
    changes: [{ next: 60, cell: "R6", sheet: "RESUMEN_NOMINA" }],
  }, dependencies().deps);
  const changed = await acceptTrustedPayrollWorkbook({
    ...INPUT,
    changes: [{ next: 30, cell: "R6", sheet: "RESUMEN_NOMINA" }],
  }, dependencies().deps);
  assert.equal(first.idempotencyKey, reordered.idempotencyKey);
  assert.notEqual(first.idempotencyKey, changed.idempotencyKey);
});

test("la compensación privilegiada elimina únicamente la ruta XLSX exacta", async () => {
  const { calls, deps } = dependencies();
  await removeUnregisteredPayrollWorkbook({
    companyId: INPUT.companyId,
    periodStart: INPUT.periodStart,
    periodEnd: INPUT.periodEnd,
    storagePath: INPUT.storagePath,
  }, deps);
  assert.deepEqual(calls, [{ name: "remove", args: [INPUT.storagePath] }]);

  await assert.rejects(
    () => removeUnregisteredPayrollWorkbook({
      companyId: INPUT.companyId,
      periodStart: INPUT.periodStart,
      periodEnd: INPUT.periodEnd,
      storagePath: `${INPUT.companyId}/otro-periodo/archivo.xlsx`,
    }, deps),
    /no corresponde/i,
  );
});

test("la migración cierra los overloads de sesión y deja un único commit service_role", () => {
  const migration = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906180000_payroll_workbook_trusted_acceptance.sql",
  ), "utf8");
  assert.match(migration, /from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.register_accepted_payroll_workbook\([\s\S]*?to service_role;/);
  assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(migration, /join public\.company_membership_roles cmr/);
  assert.match(migration, /join public\.company_roles cr/);
  assert.match(migration, /cr\.base_role = 'ADMIN_RRHH'/);
  assert.doesNotMatch(migration, /p\.role = 'ADMIN_RRHH'|cm\.role = 'ADMIN_RRHH'/);
  assert.match(migration, /private\.payroll_workbook_acceptance_receipts/);
  assert.match(migration, /p_verified_content_sha256 is distinct from p_content_sha256/);
  const sourceMutationLock = migration.indexOf("'payroll-source-mutation-v1'");
  const revisionLock = migration.indexOf("from private.payroll_source_revisions r");
  const workbookLock = migration.indexOf("'payroll-workbook|'");
  assert.ok(
    sourceMutationLock >= 0 && sourceMutationLock < revisionLock && revisionLock < workbookLock,
    "aceptación debe tomar advisory de fuentes, revisión y libro en ese orden",
  );
  assert.doesNotMatch(migration, /select \* into v_existing[\s\S]*?content_sha256 = p_content_sha256/);
});

test("la integridad final serializa fuentes, evita idempotencia por hash y vuelve inmutable la evidencia", () => {
  const migration = readFileSync(path.resolve(
    import.meta.dirname,
    "../../../supabase/migrations/20260906210000_payroll_revision_state_integrity.sql",
  ), "utf8");

  assert.match(migration, /drop index if exists public\.payroll_workbook_versions_accepted_hash_uniq/);
  assert.doesNotMatch(
    migration,
    /create\s+unique\s+index\s+(?:if not exists\s+)?payroll_workbook_versions_accepted_hash/,
  );
  assert.match(migration, /revoke insert, update, delete on public\.payroll_workbook_versions from service_role/);
  assert.match(migration, /guard_payroll_workbook_evidence_immutable/);
  assert.match(migration, /payroll_workbook_versions_evidence_immutable/);
  assert.match(migration, /payroll_workbook_changes_evidence_immutable/);
  assert.match(migration, /payroll_workbook_conflicts_evidence_immutable/);
  assert.match(migration, /new\.id is distinct from old\.id/);
  assert.match(migration, /lock_payroll_source_mutation[\s\S]*?payroll-source-mutation-v1/);
  assert.match(migration, /employee_group_assignments/);
  assert.match(migration, /for each statement execute function private\.lock_payroll_source_mutation/);
  assert.match(migration, /for each row execute function private\.bump_arcotex_payroll_source_revision/);
  assert.match(migration, /array\[to_jsonb\(old\), to_jsonb\(new\)\]/);
  assert.match(migration, /old\.status = 'CLOSED' and new\.status = 'REOPENED'/);
  assert.match(migration, /require_current_payroll_approval_for_close/);
  assert.match(migration, /prevent_arcotex_demo_cleanup_while_closed/);
  assert.match(migration, /employees_prevent_demo_cleanup_while_closed/);
  assert.match(migration, /revoke truncate on table[\s\S]*?medical_license_approvals[\s\S]*?supporting_documents[\s\S]*?audit_log[\s\S]*?from authenticated, service_role/);
  assert.match(migration, /revoke insert, update, delete on public\.supporting_documents from service_role/);
  assert.match(migration, /revoke update, delete on public\.audit_log from service_role/);
  for (const table of [
    "overtime_decisions",
    "late_arrival_decisions",
    "early_departure_decisions",
    "absence_decisions",
  ]) {
    assert.match(migration, new RegExp(`revoke insert, update, delete on public\\.${table} from service_role`));
  }
  assert.match(migration, /before insert or update or delete on public\.overtime_decisions/);
  assert.match(migration, /before insert or update or delete on public\.absence_decisions/);
  assert.match(migration, /prevent_payroll_layer_mutation_on_closed_period/);
  assert.match(migration, /prevent_assignment_history_change_on_closed_period/);
  assert.match(migration, /tg_table_name = 'supporting_documents'[\s\S]*?late_arrival_decision_id[\s\S]*?attendance_status_record_id[\s\S]*?early_departure_record_id/);
  assert.match(migration, /can_manage_employee_on_date\(employee_id, work_date\)/);
  assert.match(migration, /employees_company_is_immutable/);
  assert.match(migration, /drop policy if exists payroll_workbooks_storage_delete_orphan_owner/);
  assert.match(migration, /before insert or update or delete on storage\.objects/);
  assert.match(migration, /get_payroll_workbook_object_identity/);
  assert.match(migration, /o\.id = p_storage_object_id/);
  assert.match(migration, /o\.version is not distinct from p_storage_object_version/);
  assert.match(migration, /o\.updated_at = p_storage_object_updated_at/);
  assert.match(migration, /uuid, text, timestamptz[\s\S]*?to service_role/);
});
