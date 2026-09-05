import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadMedicalLicense, listMedicalLicenses, approveMedicalLicense, rejectMedicalLicense, computeLicenseSummary, type MedicalLicenseListItem } from "./medical-license";
import { MAX_SUPPORTING_DOCUMENT_SIZE_BYTES } from "./documents";
import { canApproveMedicalLicense } from "../supabase/authorize";

/** `employees.id` es una columna uuid: el fixture debe parecerse al dato real. */
const EMPLOYEE_ID_FIXTURE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const INTENT_ID_FIXTURE = "4f2504e0-4f89-41d3-9a0c-0305e82c3302";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

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
          delete() {
            return {
              eq(_column: string, value: string) {
                calls.push(`delete:absence_records:${value}`);
                return Promise.resolve({ error: null });
              },
            };
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
        return {
          upload: () => {
            calls.push("storage:upload");
            return Promise.resolve({ error: null });
          },
          remove: () => {
            calls.push("storage:remove");
            return Promise.resolve({ error: null });
          },
        };
      },
    },
    rpc(fnName: string, args: unknown) {
      calls.push(fnName);
      (inserted[fnName] ??= []).push(args as Record<string, unknown>);
      if (fnName === "reserve_supporting_document_upload") {
        return {
          single: () => Promise.resolve({
            data: {
              intent_id: INTENT_ID_FIXTURE,
              storage_path: `${EMPLOYEE_ID_FIXTURE}/${INTENT_ID_FIXTURE}.pdf`,
            },
            error: null,
          }),
        };
      }
      if (fnName === "create_pending_medical_license") {
        return {
          single: () => Promise.resolve(opts.failAt === "create_pending_medical_license"
            ? { data: null, error: { message: "boom" } }
            : {
                data: {
                  approval_id: "approval-1",
                  absence_record_id: "absence-record-1",
                  document_id: "document-1",
                },
                error: null,
              }),
        };
      }
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

test("uploadMedicalLicense: reserva, sube y crea ausencia+documento+aprobación mediante un único RPC atómico", async () => {
  const { client, calls, inserted } = mockSupabase();
  await uploadMedicalLicense(client, {
    employeeId: EMPLOYEE_ID_FIXTURE,
    proposedStartDate: "2026-08-20",
    proposedEndDate: "2026-08-22",
    extractionStatus: "EXTRAIDO",
    originalFilename: "certificado.pdf",
    mimeType: "application/pdf",
    fileBytes: PDF_BYTES,
  });

  assert.deepEqual(calls, ["reserve_supporting_document_upload", "storage:upload", "create_pending_medical_license"]);
  assert.deepEqual(inserted.create_pending_medical_license[0], {
    p_intent_id: INTENT_ID_FIXTURE,
    p_original_filename: "certificado.pdf",
    p_proposed_start_date: "2026-08-20",
    p_proposed_end_date: "2026-08-22",
    p_extraction_status: "EXTRAIDO",
  });
});

test("uploadMedicalLicense: TypeScript nunca envía status ni actor; el RPC y los defaults de DB son autoritativos", async () => {
  const { client, inserted } = mockSupabase();
  await uploadMedicalLicense(client, {
    employeeId: EMPLOYEE_ID_FIXTURE,
    proposedStartDate: "2026-08-20",
    proposedEndDate: "2026-08-22",
    extractionStatus: "EXTRAIDO",
    originalFilename: "certificado.pdf",
    mimeType: "application/pdf",
    fileBytes: PDF_BYTES,
  });

  const rpcArgs = inserted.create_pending_medical_license[0] as Record<string, unknown>;
  assert.equal("status" in rpcArgs, false);
  assert.equal("uploaded_by" in rpcArgs, false);
  assert.equal("actor_id" in rpcArgs, false);
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

// ---------------------------------------------------------------------------
// Atomicidad: la ausencia no puede sobrevivir a una subida fallida
// ---------------------------------------------------------------------------

/**
 * Los tres pasos no comparten transacción. Si la ausencia queda escrita y el
 * documento no, el trabajador arrastra una ausencia médica sin documento ni
 * fila de aprobación: aparece como caso pendiente y nadie puede resolverlo
 * desde la UI, porque no hay licencia que aprobar ni rechazar.
 */

const VALID_UPLOAD = {
  employeeId: EMPLOYEE_ID_FIXTURE,
  proposedStartDate: "2026-08-20",
  proposedEndDate: "2026-08-22",
  extractionStatus: "EXTRAIDO" as const,
  originalFilename: "certificado.pdf",
  mimeType: "application/pdf",
};

test("uploadMedicalLicense: un archivo sobre el máximo se rechaza ANTES de crear la ausencia", async () => {
  const { client, calls } = mockSupabase();
  // Next.js acepta hasta 12MB de body y el tope del documento son 10MB, así
  // que esta franja llega de verdad a la función.
  const tooBig = new Uint8Array(MAX_SUPPORTING_DOCUMENT_SIZE_BYTES + 1);

  await assert.rejects(() => uploadMedicalLicense(client, { ...VALID_UPLOAD, fileBytes: tooBig }), /máximo/i);
  assert.deepEqual(calls, [], "no se tocó la base: ni siquiera se creó la ausencia");
});

test("uploadMedicalLicense: si falla el commit SQL, remueve el único objeto huérfano; DB revierte sus tres filas", async () => {
  const { client, calls } = mockSupabase({ failAt: "create_pending_medical_license" });
  await assert.rejects(() => uploadMedicalLicense(client, { ...VALID_UPLOAD, fileBytes: PDF_BYTES }));
  assert.deepEqual(calls, [
    "reserve_supporting_document_upload",
    "storage:upload",
    "create_pending_medical_license",
    "storage:remove",
  ]);
});

test("uploadMedicalLicense: en el camino feliz no ejecuta compensación", async () => {
  const { client, calls } = mockSupabase();

  await uploadMedicalLicense(client, { ...VALID_UPLOAD, fileBytes: PDF_BYTES });
  assert.ok(!calls.includes("storage:remove"), "una subida correcta nunca compensa");
});
