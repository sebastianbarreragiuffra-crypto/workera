import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadMedicalLicense, listMedicalLicenses, approveMedicalLicense, rejectMedicalLicense, computeLicenseSummary, type MedicalLicenseListItem } from "./medical-license";
import { canApproveMedicalLicense } from "../supabase/authorize";

/**
 * La autorización REAL (quién puede subir/aprobar/rechazar) la exige RLS y
 * las funciones `approve_medical_license`/`reject_medical_license`
 * (probado exhaustivamente en `supabase/tests/030_medical_license_approval.sql`
 * -- 27 aserciones, incluyendo "otro ADMIN_RRHH no puede", "SUPER_ADMIN no
 * tiene bypass", "supervisor de un área no puede subir para otra área").
 * Estos tests de TS prueban que la capa de aplicación llama a las piezas
 * correctas de la forma correcta (nunca inventa su propio camino que
 * podría saltarse ese enforcement), no reimplementan la seguridad.
 */

function mockSupabase(opts: { failAt?: string } = {}) {
  const calls: string[] = [];
  const inserted: Record<string, unknown[]> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === "absence_types") {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: "absence-type-medical-leave" }, error: null }) }) }) };
      }
      if (table === "absence_records") {
        return {
          insert(row: Record<string, unknown>) {
            calls.push("insert:absence_records");
            (inserted.absence_records ??= []).push(row);
            if (opts.failAt === "absence_records") return { select: () => ({ single: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) };
            return { select: () => ({ single: () => Promise.resolve({ data: { id: "absence-record-1" }, error: null }) }) };
          },
        };
      }
      if (table === "supporting_documents") {
        return {
          insert(row: Record<string, unknown>) {
            calls.push("insert:supporting_documents");
            (inserted.supporting_documents ??= []).push(row);
            if (opts.failAt === "supporting_documents") return Promise.resolve({ error: { message: "boom" } });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "medical_license_approvals") {
        return {
          insert(row: Record<string, unknown>) {
            calls.push("insert:medical_license_approvals");
            (inserted.medical_license_approvals ??= []).push(row);
            if (opts.failAt === "medical_license_approvals") return Promise.resolve({ error: { message: "boom" } });
            return Promise.resolve({ error: null });
          },
          select() {
            return {
              order() {
                return {
                  eq: () => Promise.resolve({ data: [], error: null }),
                  // sin .eq() encadenado: listMedicalLicenses() sin filtro resuelve directo (thenable)
                  then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: LIST_FIXTURE, error: null }),
                };
              },
            };
          },
        };
      }
      throw new Error(`mockSupabase: tabla no soportada en el test: ${table}`);
    },
    storage: {
      from() {
        return { upload: () => Promise.resolve({ error: null }) };
      },
    },
    rpc(fnName: string, args: unknown) {
      calls.push(fnName);
      (inserted[fnName] ??= []).push(args as Record<string, unknown>);
      return Promise.resolve({ error: null });
    },
  };

  return { client, calls, inserted };
}

const LIST_FIXTURE = [
  {
    id: "approval-1",
    status: "PENDING_RRHH_APPROVAL",
    proposed_start_date: "2026-08-20",
    proposed_end_date: "2026-08-22",
    extraction_status: "EXTRAIDO",
    confirmed_start_date: null,
    confirmed_end_date: null,
    uploaded_at: "2026-08-19T10:00:00Z",
    approved_at: null,
    rejected_at: null,
    rejection_reason: null,
    supporting_document_id: "doc-1",
    absence_records: { employee_id: "emp-1", employees: { display_name: "María González", employee_groups: { code: "PRODUCTION" } } },
    uploader: { display_name: "Supervisor Uno" },
    approver: null,
    rejecter: null,
  },
];

test("uploadMedicalLicense: crea absence_records (manual, MEDICAL_LEAVE) + supporting_documents + medical_license_approvals, en ese orden", async () => {
  const { client, calls, inserted } = mockSupabase();
  await uploadMedicalLicense(client, {
    employeeId: "emp-1",
    proposedStartDate: "2026-08-20",
    proposedEndDate: "2026-08-22",
    extractionStatus: "EXTRAIDO",
    originalFilename: "certificado.pdf",
    mimeType: "application/pdf",
    fileBytes: new Uint8Array([1, 2, 3]),
    uploadedBy: "profile-1",
  });

  assert.deepEqual(calls, ["insert:absence_records", "insert:supporting_documents", "insert:medical_license_approvals"]);
  assert.equal((inserted.absence_records[0] as { source: string }).source, "manual");
  assert.equal((inserted.absence_records[0] as { absence_type_id: string }).absence_type_id, "absence-type-medical-leave");
});

test("uploadMedicalLicense: la fila de aprobación nace SIN status explícito -- el default de la base de datos (PENDING_RRHH_APPROVAL) es quien decide, nunca la app", async () => {
  const { client, inserted } = mockSupabase();
  await uploadMedicalLicense(client, {
    employeeId: "emp-1",
    proposedStartDate: "2026-08-20",
    proposedEndDate: "2026-08-22",
    extractionStatus: "EXTRAIDO",
    originalFilename: "certificado.pdf",
    mimeType: "application/pdf",
    fileBytes: new Uint8Array([1, 2, 3]),
    uploadedBy: "profile-1",
  });

  const approvalRow = inserted.medical_license_approvals[0] as Record<string, unknown>;
  assert.equal("status" in approvalRow, false, "el insert nunca fija status explícitamente -- si lo hiciera, sería fácil (y peligroso) escribir APPROVED por error");
});

test("listMedicalLicenses: mapea la fila unida (empleado, área, quién subió) correctamente", async () => {
  const { client } = mockSupabase();
  const result = await listMedicalLicenses(client);
  assert.equal(result.length, 1);
  assert.equal(result[0].employeeName, "María González");
  assert.equal(result[0].areaCode, "PRODUCTION");
  assert.equal(result[0].uploadedByName, "Supervisor Uno");
  assert.equal(result[0].status, "PENDING_RRHH_APPROVAL");
});

test("approveMedicalLicense: llama exactamente a la función atómica approve_medical_license con los argumentos correctos (nunca hace un UPDATE directo)", async () => {
  const { client, calls, inserted } = mockSupabase();
  await approveMedicalLicense(client, { approvalId: "approval-1", confirmedStartDate: "2026-08-20", confirmedEndDate: "2026-08-21" });

  assert.deepEqual(calls, ["approve_medical_license"]);
  assert.deepEqual(inserted.approve_medical_license[0], {
    p_approval_id: "approval-1",
    p_confirmed_start_date: "2026-08-20",
    p_confirmed_end_date: "2026-08-21",
  });
});

test("rejectMedicalLicense: llama exactamente a la función atómica reject_medical_license con los argumentos correctos", async () => {
  const { client, calls, inserted } = mockSupabase();
  await rejectMedicalLicense(client, { approvalId: "approval-1", reason: "Certificado ilegible" });

  assert.deepEqual(calls, ["reject_medical_license"]);
  assert.deepEqual(inserted.reject_medical_license[0], { p_approval_id: "approval-1", p_reason: "Certificado ilegible" });
});

test("canApproveMedicalLicense: true SOLO cuando el flag del profile es exactamente true", () => {
  assert.equal(canApproveMedicalLicense({ active: true, medical_license_approver: true }), true);
  assert.equal(canApproveMedicalLicense({ active: true, medical_license_approver: false }), false);
  assert.equal(canApproveMedicalLicense({ active: false, medical_license_approver: true }), false);
  assert.equal(canApproveMedicalLicense(null), false);
  assert.equal(canApproveMedicalLicense(undefined), false);
});

// ---------------------------------------------------------------------------
// computeLicenseSummary -- tarjeta "Licencias activas"

function license(overrides: Partial<MedicalLicenseListItem>): MedicalLicenseListItem {
  return {
    approvalId: "a1",
    status: "PENDING_RRHH_APPROVAL",
    employeeId: "e1",
    employeeName: "Empleado",
    areaCode: "PRODUCTION",
    proposedStartDate: "2026-08-01",
    proposedEndDate: "2026-08-05",
    extractionStatus: "EXTRAIDO",
    confirmedStartDate: null,
    confirmedEndDate: null,
    uploadedByName: "Supervisor",
    uploadedAt: "2026-07-30T00:00:00Z",
    approvedByName: null,
    approvedAt: null,
    rejectedByName: null,
    rejectedAt: null,
    rejectionReason: null,
    documentId: "doc-1",
    ...overrides,
  };
}

test("computeLicenseSummary: sin licencias -> hasAnyLicense=false, todo en 0", () => {
  const summary = computeLicenseSummary([], "2026-08-20");
  assert.equal(summary.hasAnyLicense, false);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.approvedCount, 0);
  assert.equal(summary.rejectedCount, 0);
  assert.equal(summary.activeNowCount, 0);
});

test("computeLicenseSummary: cuenta pendientes/aprobadas/rechazadas por separado, nunca las mezcla", () => {
  const licenses = [
    license({ status: "PENDING_RRHH_APPROVAL" }),
    license({ status: "APPROVED", confirmedStartDate: "2026-01-01", confirmedEndDate: "2026-01-05" }),
    license({ status: "REJECTED" }),
    license({ status: "REJECTED" }),
  ];
  const summary = computeLicenseSummary(licenses, "2026-08-20");
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.approvedCount, 1);
  assert.equal(summary.rejectedCount, 2);
});

test("computeLicenseSummary: 'activa hoy' es distinto de 'aprobada alguna vez' -- solo cuenta si HOY cae dentro del rango CONFIRMADO", () => {
  const licenses = [
    license({ status: "APPROVED", confirmedStartDate: "2026-01-01", confirmedEndDate: "2026-01-05" }), // aprobada, pero ya terminó
    license({ status: "APPROVED", confirmedStartDate: "2026-08-18", confirmedEndDate: "2026-08-22" }), // activa hoy
  ];
  const summary = computeLicenseSummary(licenses, "2026-08-20");
  assert.equal(summary.approvedCount, 2, "ambas cuentan como aprobadas");
  assert.equal(summary.activeNowCount, 1, "solo una está vigente hoy");
});

test("computeLicenseSummary: pendientes y rechazadas NUNCA cuentan como activas (solo lo aprobado genera efecto real)", () => {
  const licenses = [license({ status: "PENDING_RRHH_APPROVAL" }), license({ status: "REJECTED" })];
  const summary = computeLicenseSummary(licenses, "2026-08-20");
  assert.equal(summary.activeNowCount, 0);
});
